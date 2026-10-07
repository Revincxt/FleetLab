from __future__ import annotations

from dataclasses import replace
from itertools import product

import pytest

from adaptive_agent_lab.agents.fleet import FLEET_ALGORITHMS, FleetDispatcher
from adaptive_agent_lab.environment.contracts import (
    Action,
    Order,
    Position,
    RobotState,
    WarehouseMap,
)
from adaptive_agent_lab.environment.events import EventTape
from adaptive_agent_lab.environment.fleet import FleetEnvironment
from adaptive_agent_lab.environment.scenario import Scenario
from adaptive_agent_lab.environment.workforce import (
    WALK,
    WORKER_MOVE_STEPS,
    WorkerPatrol,
    WorkerState,
)


def workshop() -> Scenario:
    return Scenario(
        "pedestrian-test",
        WarehouseMap(9, 7, charging_stations=frozenset({Position(0, 0)})),
        (Order("task", Position(7, 3), Position(7, 5), 0, 500),),
        RobotState(Position(1, 3), 100),
        EventTape(),
        500,
        100,
    )


def test_seeded_patrol_moves_pauses_and_reset_repeats_the_entire_tape() -> None:
    env = FleetEnvironment(workshop(), {"agv": Position(0, 0)}, worker_count=3)

    def tape() -> list[dict[str, WorkerState]]:
        result: list[dict[str, WorkerState]] = []
        for _ in range(180):
            before = env.state
            state = env.step({"agv": Action.WAIT}).state
            assert len(state.workers) == 3
            assert len({w.position for w in state.workers.values()}) == 3
            for key, worker in state.workers.items():
                assert worker.position != Position(0, 0)
                assert worker.position.manhattan_distance(before.workers[key].position) <= 1
                for other, old in before.workers.items():
                    if other != key:
                        assert worker.position != old.position
            result.append(dict(state.workers))
        return result

    original = tape()
    for key in env.state.workers:
        states = [frame[key] for frame in original]
        assert len({worker.position for worker in states}) > 8
        assert any(worker.activity == "working" for worker in states)
        assert any(worker.activity == "walking" for worker in states)
        assert all(0 <= worker.remaining_pause <= 18 for worker in states)
    env.reset()
    assert tape() == original
    different = FleetEnvironment(
        workshop(), {"agv": Position(0, 0)}, worker_count=3, worker_seed=18
    )
    assert different.state.workers != env.reset().workers
    with pytest.raises(TypeError):
        env.state.workers["new"] = WorkerState(Position(2, 2))  # type: ignore[index]


def test_worker_occupancy_is_enforced_even_for_unsafe_callers_and_convoys() -> None:
    env = FleetEnvironment(
        workshop(),
        {"a": Position(1, 3), "b": Position(2, 3)},
        worker_starts={"person": Position(3, 3)},
    )
    before = env.state
    result = env.step({"a": Action.RIGHT, "b": Action.RIGHT})
    assert result.yielded == {"a", "b"}
    assert result.state.robots == before.robots
    assert not any(result.violations.values())


def test_incoming_worker_reserves_the_next_cell_before_a_forklift_can_enter_it() -> None:
    # The only pedestrian exit is (1, 1), also the forklift's requested target.
    scenario = Scenario(
        "incoming-worker",
        WarehouseMap(3, 2, obstacles=frozenset({Position(0, 0), Position(0, 1), Position(2, 0)})),
        (Order("task", Position(1, 0), Position(2, 1), 0, 30),),
        RobotState(Position(1, 0), 10),
        EventTape(),
        30,
        10,
    )
    env = FleetEnvironment(
        scenario, {"agv": Position(1, 0)}, worker_starts={"worker": Position(2, 1)}
    )
    assert env.worker_reservations == {Position(2, 1), Position(1, 1)}
    for _ in range(WORKER_MOVE_STEPS):
        assert env.worker_reservations == {Position(2, 1), Position(1, 1)}
        result = env.step({"agv": Action.DOWN})
        assert result.yielded == {"agv"}
        assert result.state.robots["agv"].position == Position(1, 0)
        assert result.state.robots["agv"].battery == 10
    assert result.state.workers["worker"].position == Position(1, 1)


def test_every_joint_action_keeps_people_and_forklifts_apart_including_reverse_edges() -> None:
    starts = {"a": Position(3, 2), "b": Position(2, 3)}
    for joint in product((*WALK, Action.WAIT), repeat=2):
        env = FleetEnvironment(
            workshop(), starts, worker_starts={"w1": Position(3, 3), "w2": Position(4, 3)}
        )
        before = {**starts, **{k: w.position for k, w in env.state.workers.items()}}
        reserved = env.worker_reservations
        state = env.step(dict(zip(starts, joint, strict=True))).state
        after = {
            **{k: r.position for k, r in state.robots.items()},
            **{k: w.position for k, w in state.workers.items()},
        }
        assert len(set(after.values())) == len(after)
        assert all(robot.position not in reserved for robot in state.robots.values())
        for left, a in before.items():
            for right, b in before.items():
                if left != right:
                    assert not (after[left] == b and after[right] == a)


@pytest.mark.parametrize("algorithm", FLEET_ALGORITHMS)
def test_all_dispatchers_detour_around_people_and_finish(algorithm: str) -> None:
    env = FleetEnvironment(
        workshop(), {"agv": Position(1, 3)}, worker_starts={"person": Position(2, 3)}
    )
    dispatcher = FleetDispatcher(env, algorithm=algorithm)
    actions = dispatcher.actions()
    assert actions["agv"] in {Action.UP, Action.DOWN}
    while not env.state.terminated:
        reserved = env.worker_reservations
        requested = dispatcher.actions()
        for key, action in requested.items():
            if action.is_movement:
                assert env.state.robots[key].position.moved(action) not in reserved
        result = env.step(requested)
        assert not result.yielded
        assert not any(result.violations.values())
    assert env.state.order_status["task"].value == "delivered"


def test_pause_is_bounded_and_new_closure_interrupts_inspection() -> None:
    patrol = WorkerPatrol(workshop().map, 17)
    person = WorkerState(Position(2, 2), remaining_pause=2, activity="working")
    first = patrol.advance({"w": person}, frozenset(), frozenset(), 0)["w"]
    assert first.position == person.position and first.remaining_pause == 1
    second = patrol.advance({"w": first}, frozenset(), frozenset(), 1)["w"]
    third = patrol.advance({"w": second}, frozenset(), frozenset(), 2)["w"]
    assert third.position == person.position and third.destination is not None
    evacuated = patrol.advance({"w": person}, frozenset(), frozenset({person.position}), 0)["w"]
    assert evacuated.destination is not None and evacuated.progress == 1


def test_trapped_worker_waits_then_resumes_without_teleporting() -> None:
    patrol = WorkerPatrol(workshop().map, 17)
    worker = WorkerState(Position(3, 3), Position(6, 3))
    wall = frozenset(worker.position.moved(action) for action in WALK)
    trapped = patrol.advance({"w": worker}, wall, frozenset(), 0)["w"]
    assert trapped.activity == "waiting" and trapped.position == worker.position
    resumed = patrol.advance({"w": trapped}, frozenset(), frozenset(), 1)["w"]
    assert resumed.activity == "walking"
    assert resumed.destination is not None
    assert resumed.destination.manhattan_distance(worker.position) == 1


def test_a_cell_takes_exactly_three_continuous_substeps_without_changing_pause_duration() -> None:
    patrol = WorkerPatrol(workshop().map, 17)
    current = WorkerState(Position(2, 3), target=Position(3, 3))
    for tick in range(1, WORKER_MOVE_STEPS + 1):
        current = patrol.advance({"w": current}, frozenset(), frozenset(), tick)["w"]
        assert current.activity == "walking"
        assert current.position == Position(2 if tick < 3 else 3, 3)
        assert current.progress == tick % 3
        assert current.destination == (Position(3, 3) if tick < 3 else None)
    arrived = patrol.advance({"w": current}, frozenset(), frozenset(), 4)["w"]
    assert arrived.activity == "working" and 6 <= arrived.remaining_pause <= 18


def test_mid_crossing_closure_retreats_at_the_same_slow_speed_without_a_teleport() -> None:
    patrol = WorkerPatrol(workshop().map, 17)
    source, target = Position(2, 3), Position(3, 3)
    current = WorkerState(source, target, activity="walking", destination=target, progress=2)
    first = patrol.advance({"w": current}, frozenset(), frozenset({target}), 0)["w"]
    assert first.retreating and first.progress == 1
    assert first.reserved_cells == {source, target}
    # Finish returning even if the closure disappears midway through the retreat.
    second = patrol.advance({"w": first}, frozenset(), frozenset(), 1)["w"]
    assert second.position == source and second.destination is None and second.progress == 0


def test_workers_validate_free_starts_and_capacity() -> None:
    for starts in (
        {"w": Position(0, 0)},
        {"w": Position(1, 3)},
        {"w": Position(-1, 0)},
        {"w": Position(2, 2), "v": Position(2, 2)},
    ):
        with pytest.raises(ValueError):
            FleetEnvironment(workshop(), {"agv": Position(1, 3)}, worker_starts=starts)
    for count in (-1, 1000):
        with pytest.raises(ValueError):
            FleetEnvironment(workshop(), {"agv": Position(1, 3)}, worker_count=count)
    empty = replace(workshop(), orders=())
    env = FleetEnvironment(empty, {"agv": Position(1, 3)}, worker_count=3)
    assert env.state.terminated and len(env.state.workers) == 3


def test_worker_ids_and_coordinate_types_are_validated_for_sampled_and_explicit_starts() -> None:
    for starts in (None, {"worker-01": Position(3, 3)}):
        with pytest.raises(ValueError, match="IDs must be distinct"):
            FleetEnvironment(
                workshop(), {"worker-01": Position(1, 3)}, worker_count=3, worker_starts=starts
            )
    with pytest.raises(TypeError, match="Position"):
        FleetEnvironment(
            workshop(),
            {"agv": Position(1, 3)},
            worker_starts={"w": (3, 3)},  # type: ignore[dict-item]
        )
