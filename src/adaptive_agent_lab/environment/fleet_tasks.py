"""Seeded task additions without changing factory geometry."""

from __future__ import annotations

import random
from collections import Counter, deque
from dataclasses import replace

from adaptive_agent_lab.environment.contracts import Order, Position
from adaptive_agent_lab.environment.events import DynamicEvent, EventKind, EventTape
from adaptive_agent_lab.environment.scenario import Scenario

NEIGHBORS = ((0, -1), (0, 1), (-1, 0), (1, 0))


def add_random_fleet_tasks(
    scenario: Scenario, *, total: int, seed: int, min_spacing: int = 2, unique_points: bool = True
) -> Scenario:
    """Preserve existing orders and add reachable pickup/drop-off pairs.

    A local RNG and canonical candidate ordering make an exported replay stable.
    With unique_points=False, sample rack-side pickups and open-area drop-offs
    with replacement, without endpoint de-duplication or spatial balancing.
    The legacy unique mode balances endpoints across 12 zones.
    Routing checks conservatively treat every closure cell as permanently shut.
    In unique mode, spacing one allows adjacency but forbids shared endpoints.
    """
    if isinstance(total, bool) or not isinstance(total, int) or total < len(scenario.orders):
        raise ValueError("task count must be an integer no smaller than the existing order count")
    if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
        raise ValueError("task seed must be a non-negative integer")
    if isinstance(min_spacing, bool) or not isinstance(min_spacing, int) or min_spacing < 1:
        raise ValueError("task spacing must be a positive integer")
    if not isinstance(unique_points, bool):
        raise ValueError("unique_points must be a boolean")
    if total == len(scenario.orders):
        return scenario
    if scenario.horizon < 2:
        raise ValueError("random task additions require a horizon of at least two steps")
    rng = random.Random(f"{seed}:{scenario.scenario_id}")
    grid = scenario.map
    closed = {event.position for event in scenario.events if event.position is not None}
    free = {
        Position(x, y)
        for x in range(grid.width)
        for y in range(grid.height)
        if grid.is_traversable(Position(x, y)) and Position(x, y) not in closed
    }
    cache: dict[Position, dict[Position, int]] = {}

    def distances(start: Position) -> dict[Position, int]:
        if start not in cache:
            result = {start: 0}
            queue = deque([start])
            while queue:
                point = queue.popleft()
                for dx, dy in NEIGHBORS:
                    neighbor = point.translated(dx, dy)
                    if neighbor in free and neighbor not in result:
                        result[neighbor] = result[point] + 1
                        queue.append(neighbor)
            cache[start] = result
        return cache[start]

    reachable = set(distances(scenario.initial_robot.position))
    taken = {point for order in scenario.orders for point in (order.pickup, order.dropoff)}
    reserved = set(grid.charging_stations) | {scenario.initial_robot.position}
    if unique_points:
        reserved |= taken
    candidates = sorted(reachable - reserved)
    pickups = [
        point
        for point in candidates
        if any(point.translated(dx, dy) in grid.obstacles for dx, dy in NEIGHBORS)
    ]
    dropoffs = [
        point
        for point in candidates
        if sum(point.translated(dx, dy) in free for dx, dy in NEIGHBORS) >= 3
    ]

    def zone(point: Position) -> tuple[int, int]:
        return point.x * 4 // grid.width, point.y * 3 // grid.height

    density = Counter(zone(point) for point in taken)

    def choose(points: list[Position]) -> Position:
        if not unique_points:
            return rng.choice(points)
        lowest = min(density[zone(point)] for point in points)
        return rng.choice([point for point in points if density[zone(point)] == lowest])

    def spaced(point: Position) -> bool:
        return not unique_points or all(
            point.manhattan_distance(other) >= min_spacing for other in taken
        )

    dock_costs = {
        point: min(
            (
                distances(dock).get(point, scenario.battery_capacity)
                for dock in grid.charging_stations
            ),
            default=scenario.battery_capacity,
        )
        for point in candidates
    }

    orders = list(scenario.orders)
    events = list(scenario.events)
    ids = {order.order_id for order in orders}
    count = total - len(orders)
    initial_extra = max(0, 4 - sum(order.release_time == 0 for order in orders))
    release_window = scenario.horizon // 2
    options: dict[Position, list[Position]] = {}

    def candidate_pairs() -> dict[Position, list[Position]]:
        pairs: dict[Position, list[Position]] = {}
        available_dropoffs = [point for point in dropoffs if spaced(point)]
        for pickup in pickups:
            if not spaced(pickup):
                continue
            routes = distances(pickup)
            destinations = [
                point
                for point in available_dropoffs
                if 6 <= routes.get(point, 0) <= 36
                and dock_costs[pickup] + routes[point] + dock_costs[point] + 12
                <= scenario.battery_capacity
            ]
            if destinations:
                pairs[pickup] = destinations
        return pairs

    for index in range(count):
        if unique_points or not options:
            options = candidate_pairs()
        if not options:
            raise ValueError("not enough separated, reachable task points for this task count")
        pickup = choose(list(options))
        taken.add(pickup)
        density[zone(pickup)] += 1
        dropoff = choose([point for point in options[pickup] if spaced(point)])
        taken.add(dropoff)
        density[zone(dropoff)] += 1
        release = (
            0
            if index < initial_extra
            else min(
                scenario.horizon - 2,
                1
                + (index - initial_extra) * release_window // max(1, count - initial_extra)
                + rng.randrange(max(1, release_window // max(1, count - initial_extra))),
            )
        )
        number = len(orders) + 1
        while f"order-{number:03}" in ids:
            number += 1
        order_id = f"order-{number:03}"
        ids.add(order_id)
        orders.append(
            Order(order_id, pickup, dropoff, release, scenario.horizon - 1, rng.randint(1, 5))
        )
        if release:
            events.append(DynamicEvent(release, EventKind.ORDER_ARRIVAL, order_id=order_id))
    return replace(scenario, orders=tuple(orders), event_tape=EventTape(tuple(events)))
