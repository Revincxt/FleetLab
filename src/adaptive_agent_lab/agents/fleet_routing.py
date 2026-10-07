"""Windowed space-time planning and conflict-driven priority search.

WHCA*: Silver (AIIDE 2005); PBS: Ma et al. (AAAI 2019);
RHCR: Li et al. (AAAI 2021). This is a small, independent grid implementation,
not a copy of the authors' software or a claim of completeness/optimality.
"""

from __future__ import annotations

import heapq
from collections import deque
from dataclasses import dataclass
from itertools import count

from adaptive_agent_lab.agents.planning import MOVEMENT_ACTIONS
from adaptive_agent_lab.environment.contracts import Action, Position, WarehouseMap

Path = tuple[Position, ...]
Paths = dict[str, Path]
Priorities = frozenset[tuple[str, str]]


@dataclass
class RoutingDiagnostics:
    planning_calls: int = 0
    expanded_nodes: int = 0
    priority_nodes: int = 0
    fallback_waits: int = 0


def first_conflict(paths: Paths) -> tuple[str, str] | None:
    """Return the first vertex or reverse-edge conflict in the planning window."""
    keys = list(paths)
    for time in range(1, len(next(iter(paths.values()), ()))):
        for index, left in enumerate(keys):
            for right in keys[index + 1 :]:
                a, b = paths[left], paths[right]
                if a[time] == b[time] or (a[time - 1] == b[time] and b[time - 1] == a[time]):
                    return left, right
    return None


class WindowedRouter:
    """Replan a finite window and execute a short prefix, invalidating on changes."""

    def __init__(
        self,
        warehouse_map: WarehouseMap,
        algorithm: str,
        *,
        window: int = 16,
        interval: int = 4,
        node_limit: int = 128,
        search_limit: int = 12000,
    ) -> None:
        if algorithm not in {"whca", "rhcr-pbs"}:
            raise ValueError("unknown windowed fleet algorithm")
        if not 1 <= interval <= window or node_limit < 1 or search_limit < 1:
            raise ValueError("invalid planning window or search limits")
        self.map = warehouse_map
        self.algorithm = algorithm
        self.window = window
        self.interval = interval
        self.node_limit = node_limit
        self.search_limit = search_limit
        self.diagnostics = RoutingDiagnostics()
        self._distances: dict[Position, dict[Position, int]] = {}
        self._blocked: frozenset[Position] = frozenset()
        self._signature: object = None
        self._paths: Paths = {}
        self._planned_at = -window
        self._pedestrians: list[Path] = []

    def _heuristic(self, goal: Position, blocked: frozenset[Position]) -> dict[Position, int]:
        # Reverse spatial BFS is the obstacle-aware abstract heuristic for the
        # lower-level space-time search (robots and time are abstracted away).
        if blocked != self._blocked:
            self._distances.clear()
            self._blocked = blocked
        if goal not in self._distances:
            distance = {goal: 0} if self.map.is_traversable(goal, blocked) else {}
            queue = deque(distance)
            while queue:
                point = queue.popleft()
                for action in MOVEMENT_ACTIONS:
                    neighbor = point.moved(action)
                    if neighbor not in distance and self.map.is_traversable(neighbor, blocked):
                        distance[neighbor] = distance[point] + 1
                        queue.append(neighbor)
            self._distances[goal] = distance
        return self._distances[goal]

    def space_time_path(
        self,
        start: Position,
        goal: Position,
        blocked: frozenset[Position],
        reservations: list[Path],
        battery: int,
    ) -> Path | None:
        distance = self._heuristic(goal, blocked)
        reservations = [*reservations, *self._pedestrians]
        vertices = [set(path[t] for path in reservations) for t in range(self.window + 1)]
        edges = [
            {(path[t - 1], path[t]) for path in reservations} if t else set()
            for t in range(self.window + 1)
        ]
        serial = count()
        frontier: list[tuple[int, int, int, int, Position, int]] = []
        heapq.heappush(frontier, (distance.get(start, 0), 0, 0, next(serial), start, 0))
        best = {(start, 0): 0}
        parent: dict[tuple[Position, int], tuple[Position, int]] = {}
        expanded = 0

        def reconstruct(point: Position, time: int) -> Path:
            path = [point]
            while time:
                point, time = parent[point, time]
                path.append(point)
            path.reverse()
            path.extend([path[-1]] * (self.window + 1 - len(path)))
            return tuple(path)

        while frontier and expanded < self.search_limit:
            _, _, moves, _, point, time = heapq.heappop(frontier)
            if moves != best.get((point, time)):
                continue
            expanded += 1
            self.diagnostics.expanded_nodes += 1
            if time == self.window or (
                point == goal
                and all(point not in vertices[t] for t in range(time + 1, self.window + 1))
            ):
                return reconstruct(point, time)
            for action in (*MOVEMENT_ACTIONS, Action.WAIT):
                neighbor = point.moved(action) if action.is_movement else point
                next_time = time + 1
                next_moves = moves + int(action.is_movement)
                if next_moves > battery or (
                    action.is_movement and not self.map.is_traversable(neighbor, blocked)
                ):
                    continue
                if (
                    action.is_movement
                    and neighbor in distance
                    and (next_moves + distance[neighbor] > battery)
                ):
                    # A pedestrian detour must not spend the energy needed to
                    # reach the goal (especially a charger) beyond this window.
                    continue
                if neighbor in vertices[next_time] or (neighbor, point) in edges[next_time]:
                    continue
                state = (neighbor, next_time)
                if next_moves >= best.get(state, 2**63 - 1):
                    continue
                best[state] = next_moves
                parent[state] = (point, time)
                # If a closure disconnects the goal, prefer safe waiting until
                # the observed map changes. Never peek at future closure events.
                h = distance.get(neighbor, self.map.width * self.map.height) if distance else 0
                heapq.heappush(
                    frontier, (next_time + h, h, next_moves, next(serial), neighbor, next_time)
                )
        return None

    def _whca(
        self,
        starts: dict[str, Position],
        goals: dict[str, Position],
        fixed: dict[str, Action],
        batteries: dict[str, int],
        blocked: frozenset[Position],
        time: int,
    ) -> Paths | None:
        keys = [key for key in starts if key not in fixed]
        stationary = {key: (starts[key],) * (self.window + 1) for key in fixed}
        # Rotate right-of-way between windows; bounded retries use different
        # orderings if a lower-priority robot cannot find a safe window.
        for retry in range(max(1, len(keys))):
            offset = (time // self.interval + retry) % max(1, len(keys))
            paths = dict(stationary)
            for key in keys[offset:] + keys[:offset]:
                path = self.space_time_path(
                    starts[key], goals[key], blocked, list(paths.values()), batteries[key]
                )
                if path is None:
                    break
                paths[key] = path
            if len(paths) == len(starts):
                return paths
        return None

    def _pbs(
        self,
        starts: dict[str, Position],
        goals: dict[str, Position],
        fixed: dict[str, Action],
        batteries: dict[str, int],
        blocked: frozenset[Position],
    ) -> Paths | None:
        keys = [key for key in starts if key not in fixed]
        stationary = {key: (starts[key],) * (self.window + 1) for key in fixed}
        stack: list[Priorities] = [frozenset()]
        visited: set[Priorities] = set()
        while stack and len(visited) < self.node_limit:
            priorities = stack.pop()
            if priorities in visited:
                continue
            visited.add(priorities)
            self.diagnostics.priority_nodes += 1
            paths = dict(stationary)
            remaining = list(keys)
            ancestors: dict[str, set[str]] = {}
            while remaining:
                key = next(
                    (
                        item
                        for item in remaining
                        if not any(low == item and high in remaining for high, low in priorities)
                    ),
                    None,
                )
                if key is None:  # Reject cyclic priority branches.
                    break
                higher = {high for high, low in priorities if low == key}
                ancestors[key] = higher | set().union(*(ancestors[high] for high in higher))
                reservations = [paths[high] for high in sorted(ancestors[key])]
                reservations.extend(stationary.values())
                path = self.space_time_path(
                    starts[key], goals[key], blocked, reservations, batteries[key]
                )
                if path is None:
                    break
                paths[key] = path
                remaining.remove(key)
            if remaining:
                continue
            conflict = first_conflict(paths)
            if conflict is None:
                return paths
            left, right = conflict
            # Each child imposes one ordering, then replans descendants under
            # the transitive priority relation. This is PBS, not fixed priority A*.
            for edge in ((right, left), (left, right)):
                if edge not in priorities and edge[0] not in fixed and edge[1] not in fixed:
                    stack.append(priorities | {edge})
        return None

    def paths_at(self, time: int) -> Paths:
        """Read the remaining committed window; never rerun or extend a plan."""
        age = time - self._planned_at
        if not 0 <= age <= self.window:
            return {}
        return {key: path[age:] for key, path in self._paths.items()}

    def actions(
        self,
        *,
        time: int,
        starts: dict[str, Position],
        goals: dict[str, Position],
        fixed: dict[str, Action],
        batteries: dict[str, int],
        blocked: frozenset[Position],
        occupied: frozenset[Position] = frozenset(),
    ) -> dict[str, Action]:
        signature = (tuple(goals.items()), tuple(fixed.items()), blocked, occupied)
        # Conservative reservations until the next observation. Refresh whenever
        # people move; do not guess where a random future patrol will go. Keeping
        # these separate from geometry preserves the spatial heuristic cache.
        self._pedestrians = [(point,) * (self.window + 1) for point in sorted(occupied)]
        age = time - self._planned_at
        reusable = (
            signature == self._signature
            and 0 <= age < self.interval
            and all(self._paths[key][age] == point for key, point in starts.items())
        )
        if not reusable:
            self.diagnostics.planning_calls += 1
            paths = (
                self._whca(starts, goals, fixed, batteries, blocked, time)
                if (self.algorithm == "whca")
                else self._pbs(starts, goals, fixed, batteries, blocked)
            )
            if paths is None:
                # Explicit safe fallback, never silently substitute a different solver.
                self.diagnostics.fallback_waits += 1
                paths = {key: (point,) * (self.window + 1) for key, point in starts.items()}
            self._paths, self._signature, self._planned_at = paths, signature, time
            age = 0
        result = dict(fixed)
        for key, point in starts.items():
            if key in fixed:
                continue
            next_point = self._paths[key][age + 1]
            result[key] = next(
                (action for action in MOVEMENT_ACTIONS if (point.moved(action) == next_point)),
                Action.WAIT,
            )
        return result
