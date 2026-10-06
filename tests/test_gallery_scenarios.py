from __future__ import annotations

from collections import deque
from pathlib import Path

import pytest

from adaptive_agent_lab.agents.planning import ReplanningAgent
from adaptive_agent_lab.benchmarking.runner import run_episode
from adaptive_agent_lab.environment.contracts import Position
from adaptive_agent_lab.environment.events import EventKind
from adaptive_agent_lab.environment.scenario import Scenario

ROOT = Path(__file__).resolve().parents[1]
SCENARIO_DIR = ROOT / "scenarios" / "medium"
REFERENCE_PATH = SCENARIO_DIR / "maze-warehouse.json"
SCENARIO_PATHS = tuple(
    SCENARIO_DIR / f"{name}.json"
    for name in ("maze-warehouse", "parallel-aisles", "cross-dock", "serpentine")
)
EXPECTED_OBSTACLE_COUNTS = {
    "maze-warehouse": 260,
    "parallel-aisles": 266,
    "cross-dock": 236,
    "serpentine": 252,
}
CLOSURE_WINDOWS = ((6, 44), (70, 112), (94, 138), (175, 218), (202, 246), (305, 355))
# Witnesses cross the open aisle in two steps. Every closure must force a real detour.
DETOUR_WITNESSES = {
    "maze-warehouse": (
        ((7, 6), (6, 6), (8, 6)),
        ((24, 13), (23, 13), (25, 13)),
        ((15, 9), (14, 9), (16, 9)),
        ((6, 17), (5, 17), (7, 17)),
        ((25, 6), (24, 6), (26, 6)),
        ((16, 19), (16, 18), (16, 20)),
    ),
    "parallel-aisles": (
        ((6, 6), (6, 5), (6, 7)),
        ((25, 13), (25, 12), (25, 14)),
        ((14, 9), (14, 8), (14, 10)),
        ((6, 16), (6, 15), (6, 17)),
        ((25, 6), (25, 5), (25, 7)),
        ((17, 19), (17, 18), (17, 20)),
    ),
    "cross-dock": (
        ((7, 5), (6, 5), (8, 5)),
        ((24, 13), (24, 12), (24, 14)),
        ((15, 9), (14, 9), (16, 9)),
        ((6, 16), (6, 15), (6, 17)),
        ((25, 5), (24, 5), (26, 5)),
        ((16, 19), (16, 18), (16, 20)),
    ),
    "serpentine": (
        ((6, 6), (6, 5), (6, 7)),
        ((25, 13), (25, 12), (25, 14)),
        ((15, 9), (14, 9), (16, 9)),
        ((6, 16), (6, 15), (6, 17)),
        ((25, 6), (25, 5), (25, 7)),
        ((17, 19), (17, 18), (17, 20)),
    ),
}


def _load(path: Path) -> tuple[str, Scenario]:
    text = path.read_text(encoding="utf-8")
    return text, Scenario.from_json(text)


def _distances(
    scenario: Scenario,
    start: Position,
    blocked: frozenset[Position] = frozenset(),
) -> dict[Position, int]:
    distances = {start: 0}
    queue = deque([start])
    while queue:
        current = queue.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            neighbor = current.translated(dx, dy)
            if scenario.map.is_traversable(neighbor, blocked) and neighbor not in distances:
                distances[neighbor] = distances[current] + 1
                queue.append(neighbor)
    return distances


@pytest.mark.parametrize("scenario_path", SCENARIO_PATHS, ids=lambda path: path.stem)
def test_gallery_fixture_is_canonical_and_matches_reference_workload(
    scenario_path: Path,
) -> None:
    text, scenario = _load(scenario_path)
    _, reference = _load(REFERENCE_PATH)
    assert text == scenario.to_json(indent=2) + "\n"
    assert scenario.scenario_id == f"{scenario_path.stem}-demo"
    assert (scenario.map.width, scenario.map.height) == (32, 24)
    assert scenario.horizon == reference.horizon == 960
    assert scenario.battery_capacity == reference.battery_capacity == 120
    assert scenario.initial_robot == reference.initial_robot
    assert scenario.map.charging_stations == reference.map.charging_stations
    assert len(scenario.map.charging_stations) == 4
    assert len(scenario.orders) == len(reference.orders) == 10
    assert len(scenario.map.obstacles) == EXPECTED_OBSTACLE_COUNTS[scenario_path.stem]
    assert [
        (order.order_id, order.dropoff, order.release_time, order.deadline, order.priority)
        for order in scenario.orders
    ] == [
        (order.order_id, order.dropoff, order.release_time, order.deadline, order.priority)
        for order in reference.orders
    ]
    assert [(event.time, event.kind, event.order_id) for event in scenario.events] == [
        (event.time, event.kind, event.order_id) for event in reference.events
    ]
    assert sum(order.release_time == 0 for order in scenario.orders) == 2
    assert len({order.priority for order in scenario.orders}) >= 4
    for order in scenario.orders:
        neighbors = {
            order.pickup.translated(dx, dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
        }
        assert neighbors & scenario.map.obstacles
        assert order.dropoff.x <= 1 or order.dropoff.x >= scenario.map.width - 3


@pytest.mark.parametrize("scenario_path", SCENARIO_PATHS, ids=lambda path: path.stem)
def test_expanded_layout_pairs_rack_rows_with_two_cell_aisles(
    scenario_path: Path,
) -> None:
    _, scenario = _load(scenario_path)
    warehouse = scenario.map
    obstacles = warehouse.obstacles
    assert 0.30 <= len(obstacles) / (warehouse.width * warehouse.height) < 0.36
    # Expansion is used across the floor, not just an empty border around a
    # crowded cluster. Receiving and dispatch lanes remain clear at both sides.
    assert max(p.x for p in obstacles) - min(p.x for p in obstacles) >= warehouse.width - 8
    assert max(p.y for p in obstacles) - min(p.y for p in obstacles) >= warehouse.height - 7
    assert all(2 <= p.x <= warehouse.width - 3 for p in obstacles)
    assert all(1 <= p.y <= warehouse.height - 2 for p in obstacles)

    remaining = set(obstacles)
    runs: list[set[Position]] = []
    while remaining:
        first = remaining.pop()
        run = {first}
        queue = deque([first])
        while queue:
            current = queue.popleft()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                neighbor = current.translated(dx, dy)
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    run.add(neighbor)
                    queue.append(neighbor)
        xs, ys = {p.x for p in run}, {p.y for p in run}
        # Every rectangular bank has exactly two adjacent rack rows.
        assert min(len(xs), len(ys)) == 2
        assert len(run) >= 10
        assert len(run) == (max(xs) - min(xs) + 1) * (max(ys) - min(ys) + 1)
        runs.append(run)

    # Pairing rows must not consume the two-cell aisles or crossovers.
    for index, run in enumerate(runs):
        other_racks = set().union(*runs[index + 1 :])
        for point in run:
            assert not any(
                point.translated(dx, dy) in other_racks
                for dx in range(-2, 3)
                for dy in range(-2, 3)
            )


@pytest.mark.parametrize("scenario_path", SCENARIO_PATHS, ids=lambda path: path.stem)
def test_gallery_closures_have_real_detours_and_stay_connected_when_overlapping(
    scenario_path: Path,
) -> None:
    _, scenario = _load(scenario_path)
    witnesses = [
        tuple(Position(*point) for point in witness)
        for witness in DETOUR_WITNESSES[scenario_path.stem]
    ]
    blocked_events = [event for event in scenario.events if event.kind is EventKind.CELL_BLOCKED]
    reopened = [event for event in scenario.events if event.kind is EventKind.CELL_UNBLOCKED]
    assert [(event.time, event.position) for event in blocked_events] == [
        (window[0], witness[0]) for window, witness in zip(CLOSURE_WINDOWS, witnesses, strict=True)
    ]
    assert [(event.time, event.position) for event in reopened] == [
        (window[1], witness[0]) for window, witness in zip(CLOSURE_WINDOWS, witnesses, strict=True)
    ]
    for closure, start, goal in witnesses:
        assert _distances(scenario, start)[goal] == 2
        assert _distances(scenario, start, frozenset({closure}))[goal] >= 4

    required = set(scenario.map.charging_stations) | {scenario.initial_robot.position}
    required.update(order.pickup for order in scenario.orders)
    required.update(order.dropoff for order in scenario.orders)
    active: set[Position] = set()
    maximum_overlap = 0
    for event in scenario.events:
        if event.kind is EventKind.CELL_BLOCKED:
            assert event.position is not None
            assert event.position not in required
            active.add(event.position)
        elif event.kind is EventKind.CELL_UNBLOCKED:
            active.remove(event.position)
        maximum_overlap = max(maximum_overlap, len(active))
        reachable = _distances(scenario, scenario.initial_robot.position, frozenset(active))
        assert required <= reachable.keys()
        assert len(reachable) == (
            scenario.map.width * scenario.map.height - len(scenario.map.obstacles) - len(active)
        )
    assert maximum_overlap == 2
    assert not active


@pytest.mark.parametrize("scenario_path", SCENARIO_PATHS, ids=lambda path: path.stem)
def test_replanning_completes_expanded_gallery_without_violations(scenario_path: Path) -> None:
    _, scenario = _load(scenario_path)
    result = run_episode(
        ReplanningAgent(),
        scenario,
        seed=42,
        explore=False,
        learn=False,
        measure_timing=False,
    )
    assert result.metrics.completed_orders == len(scenario.orders)
    assert result.metrics.weighted_on_time_completion_rate == 1.0
    assert result.metrics.constraint_violations == 0
    assert result.metrics.valid_movement_steps >= 350
    assert any(step.action == "charge" for step in result.trace)
