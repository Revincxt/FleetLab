from __future__ import annotations

from dataclasses import replace

import pytest

from adaptive_agent_lab.agents.fleet import FleetDispatcher
from adaptive_agent_lab.agents.fleet_routing import WindowedRouter, first_conflict
from adaptive_agent_lab.environment.contracts import (
    Action,
    Order,
    Position,
    RobotState,
    WarehouseMap,
)
from adaptive_agent_lab.environment.events import DynamicEvent, EventKind, EventTape
from adaptive_agent_lab.environment.fleet import FleetEnvironment
from adaptive_agent_lab.environment.scenario import Scenario


@pytest.mark.parametrize("algorithm", ["whca", "rhcr-pbs"])
def test_crossing_routes_resolve_vertices_and_reverse_edges(algorithm: str) -> None:
    warehouse = WarehouseMap(5, 3)
    router = WindowedRouter(warehouse, algorithm, window=8, interval=2)
    starts = {"a": Position(0, 1), "b": Position(4, 1)}
    goals = {"a": starts["b"], "b": starts["a"]}
    for time in range(12):
        fixed = {key: Action.WAIT for key in starts if starts[key] == goals[key]}
        actions = router.actions(
            time=time,
            starts=starts,
            goals=goals,
            fixed=fixed,
            batteries={key: 100 for key in starts},
            blocked=frozenset(),
        )
        assert first_conflict(router._paths) is None
        next_positions = {
            key: point.moved(actions[key]) if actions[key].is_movement else point
            for key, point in starts.items()
        }
        assert len(set(next_positions.values())) == len(starts)
        assert not (next_positions["a"] == starts["b"] and next_positions["b"] == starts["a"])
        starts = next_positions
    assert starts == goals
    assert router.diagnostics.fallback_waits == 0
    if algorithm == "rhcr-pbs":
        assert router.diagnostics.priority_nodes > router.diagnostics.planning_calls


def test_space_time_search_uses_waiting_reservations_and_energy_limits() -> None:
    router = WindowedRouter(WarehouseMap(4, 2), "whca", window=5)
    reservation = (
        Position(1, 1),
        Position(1, 0),
        Position(1, 1),
        Position(1, 1),
        Position(1, 1),
        Position(1, 1),
    )
    path = router.space_time_path(Position(0, 0), Position(3, 0), frozenset(), [reservation], 3)
    assert path is not None
    assert path[1] == path[0]  # Save energy by waiting for the crossing robot.
    assert path[-1] == Position(3, 0)
    assert first_conflict({"a": path, "b": reservation}) is None
    empty = router.space_time_path(Position(0, 0), Position(3, 0), frozenset(), [], 0)
    assert empty == (Position(0, 0),) * 6


@pytest.mark.parametrize("algorithm", ["whca", "rhcr-pbs"])
def test_rolling_window_reuses_prefix_and_invalidates_on_closures_and_goals(algorithm: str) -> None:
    router = WindowedRouter(WarehouseMap(9, 3), algorithm, window=8, interval=4)
    starts = {"a": Position(0, 1)}
    goals = {"a": Position(8, 1)}
    for time in range(2):
        actions = router.actions(
            time=time,
            starts=starts,
            goals=goals,
            fixed={},
            batteries={"a": 30 - time},
            blocked=frozenset(),
        )
        starts["a"] = starts["a"].moved(actions["a"])
    assert router.diagnostics.planning_calls == 1
    blocked = frozenset({Position(3, 1)})
    actions = router.actions(
        time=2, starts=starts, goals=goals, fixed={}, batteries={"a": 28}, blocked=blocked
    )
    assert starts["a"].moved(actions["a"]) not in blocked
    assert router.diagnostics.planning_calls == 2
    router.actions(
        time=2,
        starts=starts,
        goals={"a": Position(0, 2)},
        fixed={},
        batteries={"a": 28},
        blocked=blocked,
    )
    assert router.diagnostics.planning_calls == 3


@pytest.mark.parametrize("algorithm", ["whca", "rhcr-pbs"])
def test_occupied_service_cells_stay_reserved_and_search_limits_wait_safely(algorithm: str) -> None:
    router = WindowedRouter(WarehouseMap(5, 3), algorithm, window=8)
    starts = {"charging": Position(2, 1), "moving": Position(0, 1)}
    goals = {"charging": starts["charging"], "moving": Position(4, 1)}
    router.actions(
        time=0,
        starts=starts,
        goals=goals,
        fixed={"charging": Action.CHARGE},
        batteries={key: 100 for key in starts},
        blocked=frozenset(),
    )
    assert router._paths["charging"] == (Position(2, 1),) * 9
    assert first_conflict(router._paths) is None
    limited = WindowedRouter(WarehouseMap(5, 3), algorithm, window=8, search_limit=1)
    actions = limited.actions(
        time=0,
        starts=starts,
        goals=goals,
        fixed={},
        batteries={key: 100 for key in starts},
        blocked=frozenset(),
    )
    assert set(actions.values()) == {Action.WAIT}
    assert limited.diagnostics.fallback_waits == 1


@pytest.mark.parametrize("algorithm", ["coordinated-astar", "whca", "rhcr-pbs"])
def test_three_dispatchers_share_tasks_charging_and_authoritative_transitions(
    algorithm: str,
) -> None:
    scenario = Scenario(
        "routing-test",
        WarehouseMap(8, 5, charging_stations=frozenset({Position(0, 0), Position(7, 4)})),
        (
            Order("a", Position(1, 1), Position(6, 1), 0, 100),
            Order("b", Position(6, 3), Position(1, 3), 4, 100),
        ),
        RobotState(Position(0, 0), 40),
        EventTape((DynamicEvent(4, EventKind.ORDER_ARRIVAL, order_id="b"),)),
        100,
        40,
    )
    environment = FleetEnvironment(scenario, {"a": Position(0, 0), "b": Position(7, 4)})
    dispatcher = FleetDispatcher(environment, algorithm=algorithm)
    first = dispatcher.actions()
    assert "b" not in dispatcher.assignments.values(), "Unreleased tasks cannot be assigned"
    environment.step(first)
    while not environment.state.terminated:
        result = environment.step(dispatcher.actions())
        assert not any(result.violations.values())
        assert not result.yielded
    assert all(status.value == "delivered" for status in environment.state.order_status.values())
    # The shared charging layer pins a depleted dock resident for every solver.
    environment.reset()
    environment._state = replace(
        environment.state,
        robots={key: replace(robot, battery=5) for key, robot in environment.state.robots.items()},
    )
    dispatcher = FleetDispatcher(environment, algorithm=algorithm)
    assert set(dispatcher.actions().values()) == {Action.CHARGE}


def test_invalid_algorithms_and_windows_are_rejected() -> None:
    with pytest.raises(ValueError, match="unknown"):
        WindowedRouter(WarehouseMap(4, 4), "not-a-planner")
    with pytest.raises(ValueError, match="invalid"):
        WindowedRouter(WarehouseMap(4, 4), "whca", window=2, interval=4)


@pytest.mark.parametrize("algorithm", ["coordinated-astar", "whca", "rhcr-pbs"])
def test_shared_pickup_reconciles_actual_cargo_and_serializes_collection(algorithm: str) -> None:
    scenario = Scenario(
        "shared-pickup",
        WarehouseMap(8, 5, charging_stations=frozenset({Position(0, 0), Position(7, 4)})),
        (
            Order("first", Position(2, 1), Position(5, 1), 0, 180, 1),
            Order("urgent", Position(2, 1), Position(5, 1), 1, 180, 5),
        ),
        RobotState(Position(0, 0), 100),
        EventTape((DynamicEvent(1, EventKind.ORDER_ARRIVAL, order_id="urgent"),)),
        200,
        100,
    )
    environment = FleetEnvironment(scenario, {"a": Position(0, 0), "b": Position(7, 4)})
    dispatcher = FleetDispatcher(environment, algorithm=algorithm)
    picked = []
    while not environment.state.terminated:
        actions = dispatcher.actions()
        incoming = [
            key
            for key in dispatcher.assignments
            if not environment.state.robots[key].carried_order_id
        ]
        assert len(incoming) <= 1
        for key, robot in environment.state.robots.items():
            if robot.carried_order_id:
                assert dispatcher.assignments[key] == robot.carried_order_id
        result = environment.step(actions)
        assert not any(result.violations.values())
        for key, action in result.actions.items():
            if action is Action.PICKUP:
                picked.append(result.state.robots[key].carried_order_id)
    assert picked == ["urgent", "first"]
    assert all(status.value == "delivered" for status in environment.state.order_status.values())
