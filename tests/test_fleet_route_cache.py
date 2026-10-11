from dataclasses import replace
from unittest.mock import patch

from adaptive_agent_lab.agents import fleet as fleet_module
from adaptive_agent_lab.agents.fleet import FleetDispatcher
from adaptive_agent_lab.agents.planning import astar_path
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


def dispatcher() -> FleetDispatcher:
    start = Position(0, 1)
    scenario = Scenario(
        "route-cache",
        WarehouseMap(5, 3, charging_stations=frozenset({Position(0, 0)})),
        (),
        RobotState(start, 20),
        EventTape(),
        20,
        20,
    )
    return FleetDispatcher(FleetEnvironment(scenario, {"agv": start}))


def test_identical_static_queries_reuse_the_exact_frozen_search_result() -> None:
    controller = dispatcher()
    start, goal = Position(0, 1), Position(4, 1)
    with patch.object(fleet_module, "astar_path", wraps=astar_path) as search:
        result = controller._route(start, goal)
        assert controller._route(start, goal) is result
        assert controller._route(start, goal, avoid=set()) is result
        assert result == astar_path(controller.environment.scenario.map, start, goal)
        assert search.call_count == 1
        assert dispatcher()._route(start, goal) == result
        assert search.call_count == 2  # No cache shared between dispatchers.


def test_live_occupancy_routes_bypass_static_cache_every_time() -> None:
    controller = dispatcher()
    start, goal = Position(0, 1), Position(4, 1)
    with patch.object(fleet_module, "astar_path", wraps=astar_path) as search:
        direct = controller._route(start, goal)
        for _ in range(2):
            detour = controller._route(start, goal, avoid={Position(2, 1)})
            assert detour.cost == direct.cost + 2
            assert detour == astar_path(
                controller.environment.scenario.map, start, goal,
                blocked_cells=frozenset({Position(2, 1)}),
            )
        assert controller._route(start, goal) is direct
        assert search.call_count == 3


def test_closures_reopening_reset_and_map_changes_invalidate_cached_paths() -> None:
    controller = dispatcher()
    environment = controller.environment
    start, goal = Position(0, 1), Position(4, 1)
    environment.scenario = replace(
        environment.scenario,
        orders=(Order("pending-work", Position(0, 2), Position(4, 2), 0, 20),),
        event_tape=EventTape((
            DynamicEvent(1, EventKind.CELL_BLOCKED, Position(2, 1)),
            DynamicEvent(2, EventKind.CELL_UNBLOCKED, Position(2, 1)),
            DynamicEvent(3, EventKind.CELL_BLOCKED, goal),
        )),
    )
    environment.reset()
    with patch.object(fleet_module, "astar_path", wraps=astar_path) as search:
        assert controller._route(start, goal).cost == 4
        environment.step({"agv": Action.WAIT})
        assert controller._route(start, goal).cost == 6
        environment.step({"agv": Action.WAIT})
        assert controller._route(start, goal).cost == 4
        environment.step({"agv": Action.WAIT})
        assert not controller._route(start, goal).reached
        environment.reset()
        assert controller._route(start, goal).cost == 4
        environment.scenario = replace(
            environment.scenario,
            warehouse_map=WarehouseMap(5, 3, obstacles=frozenset({Position(2, 1)})),
            event_tape=EventTape(),
        )
        assert controller._route(start, goal).cost == 6
        assert search.call_count == 6


def test_cache_is_bounded_and_evicts_least_recently_used_queries() -> None:
    controller = dispatcher()
    start = Position(0, 1)
    goals = [Position(1, 1), Position(2, 1), Position(3, 1)]
    with (patch.object(fleet_module, "_ROUTE_CACHE_CAPACITY", 2),
          patch.object(fleet_module, "astar_path", wraps=astar_path) as search):
        first = controller._route(start, goals[0])
        controller._route(start, goals[1])
        assert controller._route(start, goals[0]) is first
        controller._route(start, goals[2])
        assert len(controller._route_cache) == 2
        assert controller._route(start, goals[0]) is first
        controller._route(start, goals[1])
        assert search.call_count == 4
        assert len(controller._route_cache) == 2
