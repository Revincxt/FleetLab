from __future__ import annotations

import random
from collections import Counter
from dataclasses import replace
from pathlib import Path

import pytest

from adaptive_agent_lab.agents.planning import astar_path
from adaptive_agent_lab.environment.contracts import Position, RobotState
from adaptive_agent_lab.environment.events import EventKind
from adaptive_agent_lab.environment.fleet_tasks import add_random_fleet_tasks
from adaptive_agent_lab.environment.scenario import Scenario

ROOT = Path(__file__).resolve().parents[1]
LAYOUTS = ("maze-warehouse", "parallel-aisles", "cross-dock", "serpentine")


def load_layout(name: str = "maze-warehouse") -> Scenario:
    return Scenario.from_json((ROOT / f"scenarios/medium/{name}.json").read_text())


@pytest.mark.parametrize("layout", LAYOUTS)
@pytest.mark.parametrize("seed", [0, 42, 43])
def test_random_tasks_preserve_layout_and_spread_unique_reachable_points(
    layout: str, seed: int
) -> None:
    base = load_layout(layout)
    source = base.to_json()
    global_rng = random.getstate()
    expanded = add_random_fleet_tasks(base, total=30, seed=seed)
    assert random.getstate() == global_rng
    assert base.to_json() == source
    assert expanded.map == base.map
    assert expanded.initial_robot == base.initial_robot
    assert expanded.horizon == base.horizon
    assert expanded.orders[:10] == base.orders
    assert len(expanded.orders) == 30
    assert sum(order.release_time == 0 for order in expanded.orders) == 4
    assert len({order.release_time for order in expanded.orders[10:]}) >= 15
    assert {event for event in expanded.events if event.kind is not EventKind.ORDER_ARRIVAL} == {
        event for event in base.events if event.kind is not EventKind.ORDER_ARRIVAL
    }
    assert Scenario.from_json(expanded.to_json()) == expanded
    points = [point for order in expanded.orders for point in (order.pickup, order.dropoff)]
    assert len(set(points)) == 60
    zones = Counter(
        (point.x * 4 // base.map.width, point.y * 3 // base.map.height) for point in points
    )
    assert len(zones) == 12
    assert min(zones.values()) >= 3
    closed = frozenset(event.position for event in base.events if event.position is not None)
    reserved = {base.initial_robot.position} | base.map.charging_stations | closed
    for point in points[20:]:
        assert point not in reserved
        assert base.map.is_traversable(point)
        assert all(point == other or point.manhattan_distance(other) >= 2 for other in points)
    for order in expanded.orders[10:]:
        route = astar_path(base.map, order.pickup, order.dropoff, blocked_cells=closed)
        assert route.reached and 6 <= route.cost <= 36
        assert any(order.pickup.manhattan_distance(point) == 1 for point in base.map.obstacles)
        assert any(
            astar_path(base.map, dock, order.pickup, blocked_cells=closed).reached
            for dock in base.map.charging_stations
        )


def test_seed_is_reproducible_and_another_seed_changes_locations() -> None:
    base = load_layout()
    first = add_random_fleet_tasks(base, total=30, seed=42)
    assert first == add_random_fleet_tasks(base, total=30, seed=42)
    other = add_random_fleet_tasks(base, total=30, seed=43)
    assert [order.pickup for order in first.orders] != [order.pickup for order in other.orders]
    assert add_random_fleet_tasks(base, total=10, seed=42) is base


@pytest.mark.parametrize("layout", LAYOUTS)
@pytest.mark.parametrize("seed", [42, 43])
def test_225_tasks_sample_with_replacement_and_release_progressively(
    layout: str, seed: int
) -> None:
    base = replace(load_layout(layout), horizon=7200)
    expanded = add_random_fleet_tasks(base, total=225, seed=seed, unique_points=False)
    assert len(expanded.orders) == len({order.order_id for order in expanded.orders}) == 225
    assert expanded.orders[:10] == base.orders
    assert expanded.map == base.map
    assert sum(order.release_time == 0 for order in expanded.orders) == 4
    assert len({order.release_time for order in expanded.orders}) > 150
    assert all(0 <= order.release_time < order.deadline < 7200 for order in expanded.orders)
    assert Scenario.from_json(expanded.to_json()) == expanded
    closed = frozenset(event.position for event in base.events if event.position is not None)
    reserved = base.map.charging_stations | {base.initial_robot.position} | closed
    for order in expanded.orders[10:]:
        assert order.pickup not in reserved and order.dropoff not in reserved
        route = astar_path(base.map, order.pickup, order.dropoff, blocked_cells=closed)
        assert route.reached and 6 <= route.cost <= 36
    # Chosen seeds naturally contain both reused and fresh endpoints. No fixed
    # overlap count or unique-point quota is imposed by the generator.
    points = [point for order in expanded.orders for point in (order.pickup, order.dropoff)]
    assert 100 < len(set(points)) < len(points)
    assert expanded == add_random_fleet_tasks(base, total=225, seed=seed, unique_points=False)
    assert expanded == add_random_fleet_tasks(
        base, total=225, seed=seed, min_spacing=100, unique_points=False
    ), "Natural sampling ignores inter-task spacing and de-duplication"


def test_invalid_unique_mode_is_rejected() -> None:
    with pytest.raises(ValueError, match="boolean"):
        add_random_fleet_tasks(load_layout(), total=30, seed=42, unique_points="false")  # type: ignore[arg-type]


@pytest.mark.parametrize("layout", LAYOUTS)
@pytest.mark.parametrize("seed", [42, 43])
@pytest.mark.parametrize("task_count", [150])
def test_large_gallery_has_unique_legal_endpoints(layout: str, seed: int, task_count: int) -> None:
    base = load_layout(layout)
    extended = replace(base, horizon=4800)
    expanded = add_random_fleet_tasks(extended, total=task_count, seed=seed, min_spacing=1)
    assert len(expanded.orders) == task_count
    assert expanded.orders[:10] == base.orders
    assert expanded.map == base.map
    assert expanded.initial_robot == base.initial_robot
    assert base.horizon == 960
    assert expanded.horizon == 4800
    assert len({order.order_id for order in expanded.orders}) == task_count
    points = [point for order in expanded.orders for point in (order.pickup, order.dropoff)]
    assert len(set(points)) == task_count * 2
    reserved = (
        base.map.charging_stations
        | {base.initial_robot.position}
        | {event.position for event in base.events if event.position is not None}
    )
    assert all(base.map.is_traversable(point) for point in points)
    assert all(point not in reserved for point in points[20:])
    assert sum(order.release_time == 0 for order in expanded.orders) == 4
    assert all(0 <= order.release_time < order.deadline < 4800 for order in expanded.orders)
    assert len({(point.x * 4 // 32, point.y * 3 // 24) for point in points}) == 12
    assert Scenario.from_json(expanded.to_json()) == expanded
    assert {event for event in expanded.events if event.kind is not EventKind.ORDER_ARRIVAL} == {
        event for event in base.events if event.kind is not EventKind.ORDER_ARRIVAL
    }


@pytest.mark.parametrize("spacing", [0, -1, True, 1.5])
def test_invalid_station_spacing_is_rejected(spacing: int) -> None:
    with pytest.raises(ValueError, match="spacing"):
        add_random_fleet_tasks(load_layout(), total=30, seed=42, min_spacing=spacing)


@pytest.mark.parametrize(
    "total,seed", [(9, 42), (True, 42), (30.5, 42), (30, -1), (30, True), (30, 1.5)]
)
def test_invalid_task_counts_and_seeds_are_rejected(total: int, seed: int) -> None:
    with pytest.raises(ValueError):
        add_random_fleet_tasks(load_layout(), total=total, seed=seed)


def test_impossible_task_density_or_battery_fails_without_partial_changes() -> None:
    base = load_layout()
    low_battery = replace(base, initial_robot=RobotState(Position(1, 22), 1), battery_capacity=1)
    with pytest.raises(ValueError, match="not enough"):
        add_random_fleet_tasks(low_battery, total=30, seed=42)
    assert len(low_battery.orders) == 10
