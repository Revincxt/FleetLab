"""Seeded, cell-occupying patrols in the same world as the forklifts.

Crossings take three simulation steps, reserving both endpoints throughout.
No future vehicle actions or event tape are consulted; stopped vehicles and
other people retain their cells.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, replace
from random import Random
from typing import Literal

from adaptive_agent_lab.environment.contracts import Action, Position, WarehouseMap

WALK = (Action.UP, Action.DOWN, Action.LEFT, Action.RIGHT)
WORKER_MOVE_STEPS = 3


@dataclass(frozen=True, slots=True)
class WorkerState:
    position: Position
    target: Position | None = None
    remaining_pause: int = 0
    activity: Literal["walking", "working", "waiting"] = "waiting"
    destination: Position | None = None
    progress: int = 0
    retreating: bool = False

    @property
    def reserved_cells(self) -> frozenset[Position]:
        # The occupied cell remains discrete. Reserve the crossing destination
        # until all three substeps finish so AGVs cannot clip a slower walker.
        return (
            frozenset((self.position, self.destination))
            if self.destination
            else frozenset((self.position,))
        )


class WorkerPatrol:
    """Random reachable inspection points and bounded, random inspection stops."""

    def __init__(self, warehouse_map: WarehouseMap, seed: int) -> None:
        self.map = warehouse_map
        self.random = Random(seed)

    def initial(
        self, count: int, occupied: frozenset[Position], starts: Mapping[str, Position] | None
    ) -> dict[str, WorkerState]:
        if starts is None:
            candidates = [
                Position(x, y)
                for y in range(self.map.height)
                for x in range(self.map.width)
                if self.map.is_traversable(Position(x, y), occupied)
                and Position(x, y) not in self.map.charging_stations
            ]
            if len(candidates) < count:
                raise ValueError("not enough free cells for workers")
            starts = {
                f"worker-{index + 1:02}": point
                for index, point in enumerate(self.random.sample(candidates, count))
            }
        if any(not isinstance(point, Position) for point in starts.values()):
            raise TypeError("worker starts must be Position values")
        if (
            any(not isinstance(key, str) or not key.strip() for key in starts)
            or len(set(starts.values())) != len(starts)
            or any(
                not self.map.is_traversable(point, occupied) or point in self.map.charging_stations
                for point in starts.values()
            )
        ):
            raise ValueError("workers need distinct free cells outside charging bays")
        return {key: WorkerState(point) for key, point in sorted(starts.items())}

    def advance(
        self,
        workers: Mapping[str, WorkerState],
        vehicles: frozenset[Position],
        blocked: frozenset[Position],
        time: int,
    ) -> dict[str, WorkerState]:
        reserved = vehicles | frozenset(
            point for worker in workers.values() for point in worker.reserved_cells
        )
        forbidden = blocked | self.map.charging_stations
        result = dict(workers)
        keys = list(workers)
        offset = time % max(1, len(keys))
        for key in keys[offset:] + keys[:offset]:
            worker = workers[key]
            if worker.destination is not None:
                retreating = worker.retreating or worker.destination in blocked
                progress = worker.progress + (-1 if retreating else 1)
                if progress == WORKER_MOVE_STEPS:
                    result[key] = WorkerState(worker.destination, worker.target, activity="walking")
                elif progress == 0:
                    result[key] = WorkerState(worker.position, worker.target, activity="walking")
                else:
                    result[key] = replace(worker, progress=progress, retreating=retreating)
                continue
            # A newly closed cell can be evacuated, even during an inspection.
            if worker.remaining_pause and worker.position not in blocked:
                result[key] = replace(
                    worker, remaining_pause=worker.remaining_pause - 1, activity="working"
                )
                continue
            if worker.target == worker.position and worker.position not in blocked:
                result[key] = replace(
                    worker,
                    target=None,
                    remaining_pause=self.random.randint(6, 18),
                    activity="working",
                )
                continue
            # BFS supplies both reachable inspection points and a safe first step.
            parent: dict[Position, Position | None] = {worker.position: None}
            queue = deque(parent)
            occupied = forbidden | reserved
            while queue:
                point = queue.popleft()
                if point == worker.target and point != worker.position:
                    break
                for action in WALK:
                    neighbor = point.moved(action)
                    if neighbor not in parent and self.map.is_traversable(neighbor, occupied):
                        parent[neighbor] = point
                        queue.append(neighbor)
            candidates = [point for point in parent if point != worker.position]
            if not candidates:
                result[key] = replace(worker, remaining_pause=0, activity="waiting")
                continue
            target = worker.target
            if target not in parent or target == worker.position:
                # Prefer an actual patrol leg over shuffling between adjacent cells.
                distant = [p for p in candidates if p.manhattan_distance(worker.position) >= 5]
                target = self.random.choice(distant or candidates)
            assert target is not None
            next_point = target
            while parent[next_point] != worker.position:
                predecessor = parent[next_point]
                assert predecessor is not None
                next_point = predecessor
            result[key] = WorkerState(
                worker.position, target, activity="walking", destination=next_point, progress=1
            )
            # Keep both endpoints reserved: people never follow into a cell being
            # vacated in this tick, preventing swaps and crossing conflicts.
            reserved = reserved | {next_point}
        return result
