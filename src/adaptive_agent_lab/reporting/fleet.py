"""Export a real, shared-world four-forklift replay for the web demo."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from dataclasses import asdict, replace
from itertools import pairwise
from pathlib import Path
from typing import cast

from adaptive_agent_lab.agents.fleet import FLEET_ALGORITHMS, FleetDispatcher
from adaptive_agent_lab.environment.contracts import Action, OrderStatus, Position
from adaptive_agent_lab.environment.fleet import FleetEnvironment, FleetStep
from adaptive_agent_lab.environment.fleet_tasks import add_random_fleet_tasks
from adaptive_agent_lab.environment.scenario import Scenario
from adaptive_agent_lab.environment.workforce import WORKER_MOVE_STEPS
from adaptive_agent_lab.reporting.artifacts import fingerprint, write_json_atomic
from adaptive_agent_lab.reporting.scenario import scenario_payload

COLORS = ("#007aff", "#aa782e", "#7964b5", "#348b75")
ORDER_STATE_CODES = ("pending", "available", "picked_up", "delivered", "expired")
PLAN_MOVE_CODES = {(0, -1): "U", (0, 1): "D", (-1, 0): "L", (1, 0): "R", (0, 0): "."}


def compact_fleet_payload(payload: dict[str, object]) -> dict[str, object]:
    """Losslessly encode task states in scenario order, retaining every frame.

    Schema 2 replaces repeated task ID/status maps with one character per task:
    0=pending, 1=available, 2=picked_up, 3=delivered, 4=expired. The simulator's
    in-memory schema remains unchanged; only the exported representation differs.
    """
    if payload.get("schemaVersion") != 1:
        raise ValueError("compact export requires a schema 1 fleet payload")
    if payload.get("kind") == "fleet-gallery":
        cases = cast(list[dict[str, object]], payload["cases"])
        return {
            **payload,
            "schemaVersion": 2,
            "cases": [compact_fleet_payload(case) for case in cases],
        }
    if payload.get("kind") != "fleet-replay":
        raise ValueError("compact export requires a fleet replay or gallery")
    scenario = cast(dict[str, object], payload["scenario"])
    orders = cast(list[dict[str, object]], scenario["orders"])
    ids = [cast(str, order["id"]) for order in orders]
    codes = {status: str(index) for index, status in enumerate(ORDER_STATE_CODES)}
    frames = cast(list[dict[str, object]], payload["frames"])
    return {
        **payload,
        "schemaVersion": 2,
        "frames": [
            {
                **frame,
                "orderStates": "".join(
                    codes[cast(dict[str, str], frame["orderStates"])[key]] for key in ids
                ),
            }
            for frame in frames
        ],
    }


def fleet_starts(scenario: Scenario) -> dict[str, Position]:
    docks = sorted(scenario.map.charging_stations - {scenario.initial_robot.position})
    positions = [scenario.initial_robot.position, *docks]
    if len(positions) < 4:
        raise ValueError("the four-vehicle demo requires four distinct starting docks")
    return {f"forklift-{index + 1:02}": point for index, point in enumerate(positions[:4])}


def build_fleet_demo(
    scenario: Scenario,
    *,
    algorithm: str = "coordinated-astar",
    worker_count: int = 3,
    worker_seed: int = 17,
) -> dict[str, object]:
    environment = FleetEnvironment(
        scenario, fleet_starts(scenario), worker_count=worker_count, worker_seed=worker_seed
    )
    dispatcher = FleetDispatcher(environment, algorithm=algorithm)
    distances: Counter[str] = Counter()
    deliveries: Counter[str] = Counter()
    waits: Counter[str] = Counter()
    flags: Counter[str] = Counter()
    frames: list[dict[str, object]] = []
    ids = list(environment.starts)

    def frame(result: FleetStep | None, requested: dict[str, Action]) -> dict[str, object]:
        state = environment.state
        vehicles: list[dict[str, object]] = []
        for key, robot in state.robots.items():
            action = result.actions[key] if result else Action.WAIT
            assigned = robot.carried_order_id or dispatcher.assignments.get(key)
            if assigned and state.order_status[assigned].is_terminal:
                assigned = None
            status = (
                "complete"
                if state.terminated
                else "yielding"
                if result and key in result.yielded
                else "charging"
                if action is Action.CHARGE
                else "delivering"
                if robot.carried_order_id
                else "waiting"
                if assigned and action is Action.WAIT
                else "collecting"
                if assigned
                else "returning"
                if action.is_movement
                else "standby"
            )
            vehicles.append(
                {
                    "id": key,
                    "position": [robot.position.x, robot.position.y],
                    "battery": robot.battery,
                    "action": action.value,
                    "requestedAction": requested.get(key, Action.WAIT).value,
                    "status": status,
                    "carriedOrderId": robot.carried_order_id,
                    "assignedOrderId": assigned,
                    "plannedMoves": "",
                    "deliveredOrderId": result.delivered.get(key) if result else None,
                    "violations": list(result.violations[key]) if result else [],
                    "distance": distances[key],
                    "deliveredOrders": deliveries[key],
                    "trafficWaits": waits[key],
                    "constraintViolations": flags[key],
                }
            )
        return {
            "time": state.time,
            "vehicles": vehicles,
            "workers": [
                {
                    "id": key,
                    "position": [worker.position.x, worker.position.y],
                    "activity": worker.activity,
                    **(
                        {"transit": [worker.destination.x, worker.destination.y, worker.progress]}
                        if worker.destination is not None
                        else {}
                    ),
                }
                for key, worker in state.workers.items()
            ],
            "orderStates": {key: status.value for key, status in state.order_status.items()},
            "blocked": [{"x": point.x, "y": point.y} for point in sorted(state.blocked_cells)],
            "completedOrders": sum(
                status is OrderStatus.DELIVERED for status in state.order_status.values()
            ),
            "terminated": state.terminated,
        }

    frames.append(frame(None, {}))
    while not environment.state.terminated:
        requested = dispatcher.actions()
        # Attach this decision to its input snapshot, not the resulting position.
        # A compact direction string preserves waits and the solver's real window.
        for vehicle in cast(list[dict[str, object]], frames[-1]["vehicles"]):
            key = cast(str, vehicle["id"])
            robot = environment.state.robots[key]
            assigned = robot.carried_order_id or dispatcher.assignments.get(key)
            vehicle["assignedOrderId"] = assigned
            path = dispatcher.planned_paths[key]
            vehicle["plannedMoves"] = "".join(
                PLAN_MOVE_CODES[(end.x - start.x, end.y - start.y)]
                for start, end in pairwise(path)
            )
        result = environment.step(requested)
        for key, action in result.actions.items():
            distances[key] += int(action.is_movement)
            deliveries[key] += int(key in result.delivered)
            waits[key] += int(key in result.yielded)
            flags[key] += len(result.violations[key])
        frames.append(frame(result, requested))
    payload: dict[str, object] = {
        "schemaVersion": 1,
        "kind": "fleet-replay",
        "verificationStatus": "DEMO · NON-CONFIRMATORY · SHARED FLEET",
        "controller": FLEET_ALGORITHMS[algorithm],
        "scenarioFingerprint": fingerprint(scenario.to_dict()),
        "scenario": scenario_payload(scenario),
        "workforce": {"count": worker_count, "seed": worker_seed, "moveSteps": WORKER_MOVE_STEPS},
        "vehicles": [
            {
                "id": key,
                "label": f"Forklift {index + 1:02}",
                "badge": f"{index + 1:02}",
                "color": COLORS[index],
                "initialPosition": {"x": environment.starts[key].x, "y": environment.starts[key].y},
            }
            for index, key in enumerate(ids)
        ],
        "summary": {
            "steps": environment.state.time,
            "completedOrders": sum(deliveries.values()),
            "totalOrders": len(scenario.orders),
            "distance": sum(distances.values()),
            "trafficWaits": sum(waits.values()),
            "constraintViolations": sum(flags.values()),
        },
        "frames": frames,
    }
    if dispatcher.router is not None:
        payload["planner"] = {
            "algorithmId": algorithm,
            "planningWindow": dispatcher.router.window,
            "replanningInterval": dispatcher.router.interval,
            **asdict(dispatcher.router.diagnostics),
        }
    return payload


def build_fleet_gallery(
    config_path: str | Path, *, seed: int | None = None, algorithm: str = "coordinated-astar"
) -> dict[str, object]:
    path = Path(config_path).resolve()
    config = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(config, dict)
        or not isinstance(config.get("cases"), list)
        or not config["cases"]
    ):
        raise ValueError("fleet config requires a non-empty cases list")
    cases: list[dict[str, object]] = []
    ids: set[str] = set()
    task_seed = config.get("taskSeed", 42) if seed is None else seed
    for case in config["cases"]:
        if not isinstance(case, dict) or any(
            not isinstance(case.get(key), str) or not case[key].strip()
            for key in ("caseId", "label", "scenario")
        ):
            raise ValueError("each fleet case requires an ID, label, and scenario path")
        if case["caseId"] in ids:
            raise ValueError("fleet case IDs must be unique")
        ids.add(case["caseId"])
        scenario = Scenario.from_json((path.parent / case["scenario"]).read_text(encoding="utf-8"))
        scenario = replace(scenario, horizon=config.get("horizon", scenario.horizon))
        scenario = add_random_fleet_tasks(
            scenario,
            total=config.get("taskCount", len(scenario.orders)),
            seed=task_seed,
            min_spacing=config.get("taskSpacing", 2),
            unique_points=config.get("uniqueTaskPoints", True),
        )
        cases.append(
            {
                "caseId": case["caseId"],
                "label": case["label"],
                **build_fleet_demo(
                    scenario,
                    algorithm=algorithm,
                    worker_count=config.get("workerCount", 3),
                    worker_seed=config.get("workerSeed", 17),
                ),
            }
        )
    if config.get("defaultCaseId") not in ids:
        raise ValueError("default fleet case must exist")
    return {
        "schemaVersion": 1,
        "kind": "fleet-gallery",
        "defaultCaseId": config["defaultCaseId"],
        "taskSeed": task_seed,
        "algorithmId": algorithm,
        "cases": cases,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--scenario", type=Path)
    source.add_argument("--config", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed", type=int, help="Override the fleet gallery's random task seed")
    parser.add_argument("--algorithm", choices=FLEET_ALGORITHMS, default="coordinated-astar")
    args = parser.parse_args()
    if args.seed is not None and not args.config:
        parser.error("--seed requires --config")
    payload = (
        build_fleet_gallery(args.config, seed=args.seed, algorithm=args.algorithm)
        if args.config
        else build_fleet_demo(
            Scenario.from_json(args.scenario.read_text(encoding="utf-8")), algorithm=args.algorithm
        )
    )
    write_json_atomic(args.output, compact_fleet_payload(payload), indent=None)
    print(f"Exported fleet replay to {args.output}")


if __name__ == "__main__":
    main()
