"""Deterministic shared-order dispatch and occupancy-aware A* routing."""

from __future__ import annotations

from adaptive_agent_lab.agents.fleet_routing import WindowedRouter
from adaptive_agent_lab.agents.planning import SearchResult, astar_path
from adaptive_agent_lab.environment.contracts import Action, OrderStatus, Position
from adaptive_agent_lab.environment.fleet import FleetEnvironment

FLEET_ALGORITHMS = {
    "coordinated-astar": "Coordinated A*",
    "whca": "WHCA*",
    "rhcr-pbs": "RHCR + PBS",
}


class FleetDispatcher:
    """Assign each order once, park idle vehicles, and replan around traffic."""

    def __init__(
        self,
        environment: FleetEnvironment,
        *,
        algorithm: str = "coordinated-astar",
        window: int = 16,
        interval: int = 4,
    ) -> None:
        if algorithm not in FLEET_ALGORITHMS:
            raise ValueError(f"unknown fleet algorithm: {algorithm}")
        self.environment = environment
        self.algorithm = algorithm
        self.router = (
            None
            if algorithm == "coordinated-astar"
            else WindowedRouter(
                environment.scenario.map, algorithm, window=window, interval=interval
            )
        )
        self.assignments: dict[str, str] = {}
        self.planned_paths: dict[str, tuple[Position, ...]] = {}
        self.charging: dict[str, Position] = {}
        self.parking: dict[str, Position] = {}
        scenario = environment.scenario
        reserved = set(scenario.map.charging_stations)
        reserved.update(order.pickup for order in scenario.orders)
        reserved.update(order.dropoff for order in scenario.orders)
        reserved.update(event.position for event in scenario.events if event.position is not None)
        for key, home in environment.starts.items():
            options = [
                Position(x, y)
                for x in range(scenario.map.width)
                for y in range(scenario.map.height)
                if scenario.map.is_traversable(Position(x, y)) and Position(x, y) not in reserved
            ]
            if not options:
                raise ValueError("fleet needs distinct parking cells away from service points")
            point = min(options, key=lambda p: (p.manhattan_distance(home), p))
            self.parking[key] = point
            reserved.add(point)

    def _route(
        self, start: Position, goal: Position, *, avoid: set[Position] | None = None
    ) -> SearchResult:
        return astar_path(
            self.environment.scenario.map,
            start,
            goal,
            blocked_cells=self.environment.state.blocked_cells | frozenset(avoid or ()),
        )

    def actions(self) -> dict[str, Action]:
        state = self.environment.state
        self.planned_paths = {
            key: (robot.position, robot.position) for key, robot in state.robots.items()
        }
        scenario = self.environment.scenario
        orders = {order.order_id: order for order in scenario.orders}
        self.assignments = {
            key: order_id
            for key, order_id in self.assignments.items()
            if state.order_status[order_id] is OrderStatus.AVAILABLE
        }
        # A shared pickup cell can contain several released tasks. The simulator
        # chooses the highest-priority one, which may have arrived after routing
        # began. Reconcile ownership from actual cargo before dispatching again.
        for key, robot in state.robots.items():
            if robot.carried_order_id:
                self.assignments[key] = robot.carried_order_id
        assigned = set(self.assignments.values())
        claimed_pickups = {
            orders[order_id].pickup
            for key, order_id in self.assignments.items()
            if not state.robots[key].carried_order_id
        }
        available = sorted(
            (
                order
                for order in scenario.orders
                if state.order_status[order.order_id] is OrderStatus.AVAILABLE
                and order.order_id not in assigned
            ),
            key=lambda order: (order.deadline, -order.priority, order.order_id),
        )
        for available_order in available:
            if available_order.pickup in claimed_pickups:
                continue
            choices = []
            for key, robot in state.robots.items():
                if key in self.assignments or key in self.charging or robot.carried_order_id:
                    continue
                route = self._route(robot.position, available_order.pickup)
                if route.reached:
                    choices.append((route.cost, key))
            if choices:
                self.assignments[min(choices)[1]] = available_order.order_id
                claimed_pickups.add(available_order.pickup)

        actions: dict[str, Action] = {}
        goals: dict[str, Position] = {}
        for key, robot in state.robots.items():
            goals[key] = robot.position
            order_id = robot.carried_order_id or self.assignments.get(key)
            order = orders.get(order_id) if order_id is not None else None
            target = (
                order.dropoff
                if order and robot.carried_order_id
                else order.pickup
                if order
                else self.parking[key]
            )
            required = self._route(robot.position, target).cost
            onward = 0
            if order and not robot.carried_order_id:
                onward = self._route(order.pickup, order.dropoff).cost
                required += onward
            service_end = order.dropoff if order else target
            charger_routes = [
                self._route(service_end, dock) for dock in scenario.map.charging_stations
            ]
            reserve = min(
                (route.cost for route in charger_routes if route.reached),
                default=scenario.battery_capacity,
            )
            needs_charge = robot.battery < required + reserve + 8
            if key in self.charging and robot.battery >= scenario.battery_capacity:
                del self.charging[key]
            if needs_charge and key not in self.charging:
                claimed = {dock for other, dock in self.charging.items() if other != key}
                docks = []
                for dock in sorted(scenario.map.charging_stations):
                    # A resident can recharge before an approaching reservation
                    # holder. Never leave a dock with insufficient task energy.
                    if dock in claimed and dock != robot.position:
                        continue
                    route = self._route(robot.position, dock)
                    service_route = self._route(dock, target)
                    if (
                        route.reached
                        and route.cost <= robot.battery
                        and service_route.reached
                        and service_route.cost + onward + reserve + 8 <= scenario.battery_capacity
                    ):
                        docks.append((route.cost, dock))
                if docks:
                    dock = min(docks)[1]
                    self.charging = {
                        other: point for other, point in self.charging.items() if point != dock
                    }
                    self.charging[key] = dock
                else:
                    # Busy chargers are a queue, not permission to consume the
                    # remaining battery on another collection or parking trip.
                    actions[key] = Action.WAIT
                    continue
            if key in self.charging:
                target = self.charging[key]
                if robot.position == target:
                    actions[key] = Action.CHARGE
                    continue
            elif order and robot.position == target:
                actions[key] = Action.DROPOFF if robot.carried_order_id else Action.PICKUP
                continue
            goals[key] = target
            if robot.position == target:
                actions[key] = Action.WAIT
        if self.router is not None:
            result = self.router.actions(
                time=state.time,
                starts={key: robot.position for key, robot in state.robots.items()},
                goals=goals,
                fixed=actions,
                batteries={key: robot.battery for key, robot in state.robots.items()},
                blocked=state.blocked_cells,
                occupied=self.environment.worker_reservations,
            )
            self.planned_paths = self.router.paths_at(state.time)
            return result
        occupied = {robot.position for robot in state.robots.values()} | set(
            self.environment.worker_reservations
        )
        for key, robot in state.robots.items():
            if key in actions:
                continue
            target = goals[key]
            route = self._route(robot.position, target, avoid=occupied - {robot.position})
            actions[key] = (
                route.actions[0]
                if route.reached and route.actions and route.cost <= robot.battery
                else Action.WAIT
            )
            if actions[key].is_movement:
                points = [robot.position]
                for action in route.actions:
                    points.append(points[-1].moved(action))
                self.planned_paths[key] = tuple(points)
                # Reserve this destination and release the vacated cell for the
                # next planner. This breaks symmetric side-stepping in aisles;
                # the environment still arbitrates every simultaneous move.
                occupied.remove(robot.position)
                occupied.add(robot.position.moved(actions[key]))
        return actions
