"""Synchronized fleet transitions, separate from the single-robot benchmark.

Vehicles share one order book and event tape. Traffic reservations prevent both
same-cell collisions and head-on swaps; rejected moves become recorded waits.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from types import MappingProxyType

from adaptive_agent_lab.environment.contracts import Action, OrderStatus, Position, RobotState
from adaptive_agent_lab.environment.events import EventKind
from adaptive_agent_lab.environment.scenario import Scenario
from adaptive_agent_lab.environment.workforce import WorkerPatrol, WorkerState


@dataclass(frozen=True, slots=True)
class FleetState:
    time: int
    robots: Mapping[str, RobotState]
    order_status: Mapping[str, OrderStatus]
    blocked_cells: frozenset[Position]
    terminated: bool
    workers: Mapping[str, WorkerState] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "robots", MappingProxyType(dict(self.robots)))
        object.__setattr__(self, "order_status", MappingProxyType(dict(self.order_status)))
        object.__setattr__(self, "workers", MappingProxyType(dict(self.workers)))


@dataclass(frozen=True, slots=True)
class FleetStep:
    state: FleetState
    actions: Mapping[str, Action]
    yielded: frozenset[str]
    violations: Mapping[str, tuple[str, ...]]
    delivered: Mapping[str, str]

    def __post_init__(self) -> None:
        for name in ("actions", "violations", "delivered"):
            object.__setattr__(self, name, MappingProxyType(dict(getattr(self, name))))


class FleetEnvironment:
    """Authoritative joint-action simulation with unit-capacity forklifts."""

    def __init__(
        self,
        scenario: Scenario,
        starts: Mapping[str, Position],
        *,
        worker_count: int = 0,
        worker_seed: int = 17,
        worker_starts: Mapping[str, Position] | None = None,
    ) -> None:
        if scenario.initial_robot.carried_order_id is not None:
            raise ValueError("fleet episodes must start without a carried order")
        if not starts or any(not isinstance(key, str) or not key.strip() for key in starts):
            raise ValueError("a fleet needs non-empty vehicle IDs")
        if any(not isinstance(point, Position) for point in starts.values()):
            raise TypeError("fleet starts must be Position values")
        if len(set(starts.values())) != len(starts):
            raise ValueError("vehicles must start in distinct cells")
        if any(not scenario.map.is_traversable(point) for point in starts.values()):
            raise ValueError("vehicle starts must be traversable")
        self.scenario = scenario
        self.starts = MappingProxyType(dict(sorted(starts.items())))
        if type(worker_count) is not int or worker_count < 0 or type(worker_seed) is not int:
            raise ValueError("worker count must be nonnegative and worker seed must be an integer")
        self.worker_count = worker_count
        self.worker_seed = worker_seed
        self.worker_starts = dict(worker_starts) if worker_starts is not None else None
        self._orders = {order.order_id: order for order in scenario.orders}
        self._state: FleetState
        self.reset()

    @property
    def state(self) -> FleetState:
        return self._state

    @property
    def worker_reservations(self) -> frozenset[Position]:
        """Occupied cells and committed next cells, not predicted future patrols."""
        return frozenset(
            point
            for workers in (self.state.workers, self._next_workers)
            for worker in workers.values()
            for point in worker.reserved_cells
        )

    def _plan_workers(self) -> None:
        self._next_workers = self._patrol.advance(
            self.state.workers,
            frozenset(robot.position for robot in self.state.robots.values()),
            self.state.blocked_cells,
            self.state.time,
        )

    def reset(self) -> FleetState:
        statuses = {
            order.order_id: OrderStatus.AVAILABLE
            if order.release_time == 0
            else OrderStatus.PENDING
            for order in self.scenario.orders
        }
        blocked: set[Position] = set()
        self._events(0, statuses, blocked)
        if blocked & set(self.starts.values()):
            raise ValueError("vehicle starts cannot be dynamically blocked at time zero")
        self._patrol = WorkerPatrol(self.scenario.map, self.worker_seed)
        workers = self._patrol.initial(
            self.worker_count,
            frozenset(blocked) | frozenset(self.starts.values()),
            self.worker_starts,
        )
        if set(workers) & set(self.starts):
            raise ValueError("worker and vehicle IDs must be distinct")
        self._state = FleetState(
            0,
            {
                key: RobotState(point, self.scenario.battery_capacity)
                for key, point in self.starts.items()
            },
            statuses,
            frozenset(blocked),
            not statuses,
            workers,
        )
        self._plan_workers()
        return self.state

    def _events(self, time: int, statuses: dict[str, OrderStatus], blocked: set[Position]) -> None:
        for event in self.scenario.event_tape.at(time):
            if event.kind is EventKind.ORDER_ARRIVAL:
                assert event.order_id is not None
                if statuses[event.order_id] is OrderStatus.PENDING:
                    statuses[event.order_id] = OrderStatus.AVAILABLE
            elif event.kind is EventKind.CELL_BLOCKED:
                assert event.position is not None
                blocked.add(event.position)
            elif event.kind is EventKind.CELL_UNBLOCKED:
                assert event.position is not None
                blocked.discard(event.position)

    def step(self, requested: Mapping[str, Action]) -> FleetStep:
        if self.state.terminated:
            raise ValueError("cannot advance a terminated fleet episode")
        if set(requested) != set(self.starts):
            raise ValueError("provide exactly one action for every vehicle")
        if any(not isinstance(action, Action) for action in requested.values()):
            raise TypeError("fleet actions must be Action values")
        previous = self.state
        robots = dict(previous.robots)
        statuses = dict(previous.order_status)
        blocked = set(previous.blocked_cells)
        actions = dict(requested)
        violations: dict[str, list[str]] = {key: [] for key in robots}
        targets = {key: robot.position for key, robot in robots.items()}
        yielded: set[str] = set()
        for key, robot in robots.items():
            if not actions[key].is_movement:
                continue
            target = robot.position.moved(actions[key])
            violation = (
                "battery_depleted"
                if robot.battery <= 0
                else "out_of_bounds"
                if not self.scenario.map.contains(target)
                else "static_obstacle"
                if target in self.scenario.map.obstacles
                else "dynamic_blockage"
                if target in blocked
                else None
            )
            if violation:
                violations[key].append(violation)
                actions[key] = Action.WAIT
            elif target in self.worker_reservations:
                # Pedestrians have right-of-way; retain battery and record a
                # traffic yield even when a caller ignores planner reservations.
                actions[key] = Action.WAIT
                yielded.add(key)
            else:
                targets[key] = target

        # Rotate right-of-way. A stopped car retains its cell; cancellation may
        # propagate backward through a convoy, so resolve to a fixed point.
        keys = list(robots)
        offset = previous.time % len(keys)
        priority = keys[offset:] + keys[:offset]
        while True:
            cancelled: set[str] = set()
            for target, count in Counter(targets.values()).items():
                if count < 2:
                    continue
                contenders = [key for key in priority if targets[key] == target]
                resident = next((key for key in contenders if robots[key].position == target), None)
                winner = resident or contenders[0]
                cancelled.update(key for key in contenders if key != winner)
            for index, key in enumerate(keys):
                for other in keys[index + 1 :]:
                    if (
                        targets[key] == robots[other].position
                        and targets[other] == robots[key].position
                        and targets[key] != targets[other]
                    ):
                        cancelled.update((key, other))
            cancelled = {key for key in cancelled if targets[key] != robots[key].position}
            if not cancelled:
                break
            for key in cancelled:
                targets[key] = robots[key].position
                actions[key] = Action.WAIT
            yielded.update(cancelled)

        delivered: dict[str, str] = {}
        for key in keys:
            robot = robots[key]
            action = actions[key]
            if action.is_movement:
                robots[key] = replace(robot, position=targets[key], battery=robot.battery - 1)
            elif action is Action.PICKUP:
                candidates = sorted(
                    (
                        order
                        for order in self.scenario.orders
                        if order.pickup == robot.position
                        and statuses[order.order_id] is OrderStatus.AVAILABLE
                    ),
                    key=lambda order: (order.deadline, -order.priority, order.order_id),
                )
                if robot.carried_order_id is not None or not candidates:
                    violations[key].append("no_order_at_pickup")
                else:
                    order = candidates[0]
                    statuses[order.order_id] = OrderStatus.PICKED_UP
                    robots[key] = replace(robot, carried_order_id=order.order_id)
            elif action is Action.DROPOFF:
                carried = robot.carried_order_id
                if carried is None:
                    violations[key].append("not_carrying_order")
                elif self._orders[carried].dropoff != robot.position:
                    violations[key].append("wrong_dropoff")
                else:
                    statuses[carried] = OrderStatus.DELIVERED
                    delivered[key] = carried
                    robots[key] = replace(robot, carried_order_id=None)
            elif action is Action.CHARGE:
                if robot.position not in self.scenario.map.charging_stations:
                    violations[key].append("not_at_charger")
                else:
                    robots[key] = replace(
                        robot, battery=min(self.scenario.battery_capacity, robot.battery + 2)
                    )

        time = previous.time + 1
        self._events(time, statuses, blocked)
        terminated = all(status is OrderStatus.DELIVERED for status in statuses.values())
        if time >= self.scenario.horizon:
            statuses = {
                key: status if status.is_terminal else OrderStatus.EXPIRED
                for key, status in statuses.items()
            }
            robots = {key: replace(robot, carried_order_id=None) for key, robot in robots.items()}
            terminated = True
        self._state = FleetState(
            time, robots, statuses, frozenset(blocked), terminated, self._next_workers
        )
        self._plan_workers()
        return FleetStep(
            self.state,
            actions,
            frozenset(yielded),
            {key: tuple(items) for key, items in violations.items()},
            delivered,
        )
