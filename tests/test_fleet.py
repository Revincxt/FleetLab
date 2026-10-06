from __future__ import annotations

import json
from collections import Counter
from dataclasses import replace
from itertools import product
from pathlib import Path

import pytest

from adaptive_agent_lab.agents.fleet import FleetDispatcher
from adaptive_agent_lab.environment.contracts import (
    Action,
    Order,
    OrderStatus,
    Position,
    RobotState,
    WarehouseMap,
)
from adaptive_agent_lab.environment.events import DynamicEvent, EventKind, EventTape
from adaptive_agent_lab.environment.fleet import FleetEnvironment
from adaptive_agent_lab.environment.fleet_tasks import add_random_fleet_tasks
from adaptive_agent_lab.environment.scenario import Scenario
from adaptive_agent_lab.reporting.artifacts import fingerprint
from adaptive_agent_lab.reporting.fleet import (
    ORDER_STATE_CODES,
    build_fleet_demo,
    compact_fleet_payload,
    fleet_starts,
)

ROOT = Path(__file__).resolve().parents[1]


def test_compact_order_states_are_lossless_in_scenario_order_and_do_not_mutate() -> None:
    ids = ["z", "a", "c", "b", "x"]
    states = dict(zip(ids, ORDER_STATE_CODES, strict=True))
    frame = {"time": 0, "orderStates": states, "vehicles": []}
    payload = {
        "schemaVersion": 1,
        "kind": "fleet-replay",
        "scenario": {"orders": [{"id": key} for key in ids]},
        "frames": [frame],
    }
    packed = compact_fleet_payload(payload)
    assert packed["schemaVersion"] == 2
    assert packed["frames"] == [{**frame, "orderStates": "01234"}]
    assert payload["schemaVersion"] == 1
    assert frame["orderStates"] is states
    assert dict(zip(ids, (ORDER_STATE_CODES[int(code)] for code in "01234"), strict=True)) == states
    gallery = compact_fleet_payload(
        {"schemaVersion": 1, "kind": "fleet-gallery", "cases": [payload]}
    )
    assert gallery["cases"] == [packed]
    with pytest.raises(ValueError, match="schema 1"):
        compact_fleet_payload(packed)


def scenario(*, horizon: int = 30, battery: int = 12) -> Scenario:
    return Scenario(
        "fleet-test",
        WarehouseMap(6, 4, charging_stations=frozenset({Position(0, 0), Position(5, 0)})),
        (
            Order("a", Position(1, 1), Position(4, 1), 0, horizon),
            Order("b", Position(1, 2), Position(4, 2), 0, horizon),
        ),
        RobotState(Position(0, 0), battery),
        EventTape(),
        horizon,
        battery,
    )


def test_vertex_reservations_and_head_on_swaps_are_safe() -> None:
    environment = FleetEnvironment(scenario(), {"a": Position(0, 1), "b": Position(2, 1)})
    result = environment.step({"a": Action.RIGHT, "b": Action.LEFT})
    assert result.state.robots["a"].position == Position(1, 1)
    assert result.state.robots["b"].position == Position(2, 1)
    assert result.yielded == {"b"}
    assert result.state.robots["b"].battery == 12
    assert not any(result.violations.values())
    swapped = environment.step({"a": Action.RIGHT, "b": Action.LEFT})
    assert swapped.yielded == {"a", "b"}
    assert swapped.state.robots == result.state.robots


def test_stopped_convoy_cancels_backwards_but_moving_convoy_can_follow() -> None:
    environment = FleetEnvironment(
        scenario(), {"a": Position(0, 0), "b": Position(1, 0), "c": Position(2, 0)}
    )
    initial = environment.state
    result = environment.step({"a": Action.RIGHT, "b": Action.RIGHT, "c": Action.WAIT})
    assert result.yielded == {"a", "b"}
    assert result.state.robots == initial.robots
    result = environment.step({key: Action.RIGHT for key in initial.robots})
    assert [robot.position.x for robot in result.state.robots.values()] == [1, 2, 3]
    assert not result.yielded


def test_all_joint_moves_preserve_unique_positions_and_never_swap_edges() -> None:
    starts = {"a": Position(1, 1), "b": Position(2, 1), "c": Position(2, 2)}
    for joint in product(
        (Action.UP, Action.DOWN, Action.LEFT, Action.RIGHT, Action.WAIT), repeat=3
    ):
        environment = FleetEnvironment(scenario(), starts)
        result = environment.step(dict(zip(starts, joint, strict=True)))
        positions = {key: robot.position for key, robot in result.state.robots.items()}
        assert len(set(positions.values())) == 3
        for key, position in positions.items():
            assert starts[key].manhattan_distance(position) <= 1
            assert not any(
                position == starts[other] and positions[other] == starts[key]
                for other in starts
                if other != key
            )


def test_orders_are_shared_and_each_delivery_occurs_exactly_once() -> None:
    environment = FleetEnvironment(scenario(), {"a": Position(1, 1), "b": Position(1, 2)})
    picked = environment.step({"a": Action.PICKUP, "b": Action.PICKUP})
    assert {robot.carried_order_id for robot in picked.state.robots.values()} == {"a", "b"}
    assert set(picked.state.order_status.values()) == {OrderStatus.PICKED_UP}
    invalid = environment.step({"a": Action.PICKUP, "b": Action.DROPOFF})
    assert invalid.violations["a"] == ("no_order_at_pickup",)
    assert invalid.violations["b"] == ("wrong_dropoff",)
    for _ in range(3):
        environment.step({"a": Action.RIGHT, "b": Action.RIGHT})
    delivered = environment.step({"a": Action.DROPOFF, "b": Action.DROPOFF})
    assert delivered.delivered == {"a": "a", "b": "b"}
    assert delivered.state.terminated
    assert set(delivered.state.order_status.values()) == {OrderStatus.DELIVERED}
    with pytest.raises(ValueError, match="terminated"):
        environment.step({"a": Action.DROPOFF, "b": Action.DROPOFF})
    assert environment.reset().time == 0
    with pytest.raises(TypeError):
        environment.state.robots["a"] = RobotState(Position(0, 0), 1)  # type: ignore[index]


def test_battery_charging_and_horizon_expiry() -> None:
    environment = FleetEnvironment(
        scenario(horizon=5, battery=1), {"a": Position(1, 0), "b": Position(4, 0)}
    )
    environment.step({"a": Action.LEFT, "b": Action.RIGHT})
    failed = environment.step({"a": Action.DOWN, "b": Action.DOWN})
    assert all(flags == ("battery_depleted",) for flags in failed.violations.values())
    charged = environment.step({"a": Action.CHARGE, "b": Action.CHARGE})
    assert all(robot.battery == 1 for robot in charged.state.robots.values())
    environment.step({"a": Action.DOWN, "b": Action.DOWN})
    expired = environment.step({"a": Action.CHARGE, "b": Action.WAIT})
    assert expired.violations["a"] == ("not_at_charger",)
    assert expired.state.terminated
    assert set(expired.state.order_status.values()) == {OrderStatus.EXPIRED}


def test_events_are_shared_and_closures_allow_an_occupant_to_leave() -> None:
    base = scenario()
    dynamic = replace(
        base,
        orders=(*base.orders, Order("c", Position(3, 2), Position(4, 3), 2, 30)),
        event_tape=EventTape(
            (
                DynamicEvent(1, EventKind.CELL_BLOCKED, Position(2, 0)),
                DynamicEvent(2, EventKind.ORDER_ARRIVAL, order_id="c"),
                DynamicEvent(3, EventKind.CELL_UNBLOCKED, Position(2, 0)),
            )
        ),
    )
    environment = FleetEnvironment(dynamic, {"a": Position(1, 0), "b": Position(4, 0)})
    first = environment.step({"a": Action.RIGHT, "b": Action.LEFT})
    assert Position(2, 0) in first.state.blocked_cells
    second = environment.step({"a": Action.DOWN, "b": Action.LEFT})
    assert second.state.robots["a"].position == Position(2, 1)
    assert second.violations["b"] == ("dynamic_blockage",)
    assert second.state.order_status["c"] is OrderStatus.AVAILABLE
    reopened = environment.step({"a": Action.WAIT, "b": Action.WAIT})
    assert not reopened.state.blocked_cells


def test_fleet_validates_starts_and_complete_action_sets() -> None:
    for starts in (
        {},
        {"": Position(0, 0)},
        {"a": Position(-1, 0)},
        {"a": Position(0, 0), "b": Position(0, 0)},
    ):
        with pytest.raises(ValueError):
            FleetEnvironment(scenario(), starts)
    environment = FleetEnvironment(scenario(), {"a": Position(0, 0), "b": Position(5, 0)})
    with pytest.raises(ValueError, match="every vehicle"):
        environment.step({"a": Action.WAIT})
    with pytest.raises(TypeError):
        environment.step({"a": "wait", "b": Action.WAIT})  # type: ignore[dict-item]
    with pytest.raises(ValueError, match="four"):
        fleet_starts(scenario())


@pytest.mark.parametrize("case_index", range(4))
@pytest.mark.parametrize(
    ("algorithm", "filename"),
    [("coordinated-astar", "fleet-demo"), ("whca", "fleet-whca"), ("rhcr-pbs", "fleet-rhcr-pbs")],
)
def test_checked_in_fleet_is_deterministic_and_replays_every_shared_transition(
    case_index: int,
    algorithm: str,
    filename: str,
) -> None:
    config = json.loads((ROOT / "configs/fleet-demo.json").read_text())
    case = config["cases"][case_index]
    source = Scenario.from_json((ROOT / "configs" / case["scenario"]).read_text())
    source = replace(source, horizon=config["horizon"])
    source = add_random_fleet_tasks(
        source,
        total=config["taskCount"],
        seed=config["taskSeed"],
        min_spacing=config["taskSpacing"],
        unique_points=config["uniqueTaskPoints"],
    )
    gallery = json.loads((ROOT / f"web/public/{filename}.json").read_text())
    assert gallery["kind"] == "fleet-gallery"
    assert gallery["defaultCaseId"] == "rack-maze"
    assert gallery["taskSeed"] == config["taskSeed"]
    assert [item["caseId"] for item in gallery["cases"]] == [
        item["caseId"] for item in config["cases"]
    ]
    payload = gallery["cases"][case_index]
    assert gallery["schemaVersion"] == 2
    assert payload == compact_fleet_payload(
        {
            "caseId": case["caseId"],
            "label": case["label"],
            **build_fleet_demo(source, algorithm=algorithm),
        }
    )
    assert payload["scenarioFingerprint"] == fingerprint(source.to_dict())
    assert len(payload["vehicles"]) == 4
    environment = FleetEnvironment(source, fleet_starts(source))
    delivered: Counter[str] = Counter()
    movement: Counter[str] = Counter()
    assert payload["frames"][0]["time"] == 0
    assert [record["position"] for record in payload["frames"][0]["vehicles"]] == [
        [robot.position.x, robot.position.y] for robot in environment.state.robots.values()
    ]
    for frame in payload["frames"][1:]:
        old_positions = {key: robot.position for key, robot in environment.state.robots.items()}
        result = environment.step(
            {vehicle["id"]: Action(vehicle["requestedAction"]) for vehicle in frame["vehicles"]}
        )
        assert result.state.time == frame["time"]
        assert {key: status.value for key, status in result.state.order_status.items()} == {
            order["id"]: ORDER_STATE_CODES[int(code)]
            for order, code in zip(payload["scenario"]["orders"], frame["orderStates"], strict=True)
        }
        assert sorted([point.x, point.y] for point in result.state.blocked_cells) == sorted(
            [point["x"], point["y"]] for point in frame["blocked"]
        )
        assert result.state.terminated == frame["terminated"]
        assert len({robot.position for robot in result.state.robots.values()}) == 4
        for record in frame["vehicles"]:
            key = record["id"]
            robot = result.state.robots[key]
            assert record["position"] == [robot.position.x, robot.position.y]
            assert record["battery"] == robot.battery
            assert record["carriedOrderId"] == robot.carried_order_id
            if robot.carried_order_id:
                assert record["assignedOrderId"] == robot.carried_order_id
            assert record["deliveredOrderId"] == result.delivered.get(key)
            assert record["action"] == result.actions[key].value
            assert record["violations"] == list(result.violations[key]) == []
            delivered[key] += int(key in result.delivered)
            movement[key] += int(result.actions[key].is_movement)
            assert record["deliveredOrders"] == delivered[key]
            assert record["distance"] == movement[key]
            assert not any(
                robot.position == old_positions[other]
                and result.state.robots[other].position == old_positions[key]
                for other in old_positions
                if key != other
            )
    assert sum(delivered.values()) == len(source.orders) == config["taskCount"] == 225
    assert all(delivered[key] > 0 and movement[key] > 0 for key in environment.starts)
    assert environment.state.terminated
    assert payload["summary"]["constraintViolations"] == 0


@pytest.mark.parametrize(
    "filename", ["maze-warehouse", "parallel-aisles", "cross-dock", "serpentine"]
)
def test_dispatcher_never_assigns_an_order_to_two_vehicles(filename: str) -> None:
    source = Scenario.from_json((ROOT / f"scenarios/medium/{filename}.json").read_text())
    source = add_random_fleet_tasks(source, total=30, seed=43)
    environment = FleetEnvironment(source, fleet_starts(source))
    dispatcher = FleetDispatcher(environment)
    while not environment.state.terminated:
        actions = dispatcher.actions()
        assert len(dispatcher.assignments.values()) == len(set(dispatcher.assignments.values()))
        assert len(dispatcher.charging.values()) == len(set(dispatcher.charging.values()))
        result = environment.step(actions)
        assert not any(result.violations.values())
    assert set(environment.state.order_status.values()) == {OrderStatus.DELIVERED}


def test_low_battery_vehicle_waits_when_reachable_chargers_are_reserved() -> None:
    environment = FleetEnvironment(
        scenario(battery=30), {"a": Position(1, 0), "b": Position(0, 0), "c": Position(5, 0)}
    )
    environment._state = replace(
        environment.state,
        robots={
            key: replace(robot, battery=1 if key == "a" else 5)
            for key, robot in environment.state.robots.items()
        },
    )
    dispatcher = FleetDispatcher(environment)
    dispatcher.charging = {"b": Position(0, 0), "c": Position(5, 0)}
    actions = dispatcher.actions()
    assert actions == {"a": Action.WAIT, "b": Action.CHARGE, "c": Action.CHARGE}
    result = environment.step(actions)
    assert result.state.robots["a"].battery == 1
    assert not any(result.violations.values())


def test_low_battery_dock_resident_recharges_before_approaching_reservation() -> None:
    environment = FleetEnvironment(scenario(battery=30), {"a": Position(0, 0), "b": Position(2, 0)})
    environment._state = replace(
        environment.state,
        robots={
            key: replace(robot, battery=2 if key == "a" else 30)
            for key, robot in environment.state.robots.items()
        },
    )
    dispatcher = FleetDispatcher(environment)
    dispatcher.charging = {"b": Position(0, 0)}
    actions = dispatcher.actions()
    assert actions["a"] is Action.CHARGE
    assert dispatcher.charging["a"] == Position(0, 0)
    assert dispatcher.charging.get("b") != Position(0, 0)
    assert not any(environment.step(actions).violations.values())
