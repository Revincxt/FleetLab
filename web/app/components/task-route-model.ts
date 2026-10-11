import type { FleetReplay, VehicleState } from "./fleet-model";
import type { GridPoint, TaskRoute } from "./maze-model";

const moves: Record<string, [number, number]> = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0], ".": [0, 0] };

/** These directions are recorded solver output, never future executed positions. */
export function decodePlannedRoute(start: GridPoint, codes: string): GridPoint[] {
  const points = [{ ...start }];
  for (const code of codes) {
    const delta = moves[code];
    if (!delta) throw new Error("Invalid planned route direction.");
    const previous = points[points.length - 1];
    points.push({ x: previous.x + delta[0], y: previous.y + delta[1] });
  }
  return points;
}

const taskId = (vehicle: VehicleState) => vehicle.carriedOrderId ?? vehicle.assignedOrderId;
const point = (vehicle: VehicleState) => ({ x: vehicle.position[0], y: vehicle.position[1] });
type AssignmentStart = { time: number; orderId: string; start: number };
// One cursor per vehicle, not a retained route for every frame. Replay tapes
// are immutable; weak keys also release cursors when an algorithm is unloaded.
const assignmentStarts = new WeakMap<FleetReplay, Map<number, AssignmentStart>>();

/** Every vehicle's task route is visible, independently of the inspector selection. */
export function currentTaskRoutes(replay: FleetReplay, time: number): Record<string, TaskRoute | null> {
  return Object.fromEntries((replay.frames[time]?.vehicles ?? []).map((vehicle, index) =>
    [vehicle.id, currentTaskRoute(replay, time, index)]
  ));
}

/** Bound history to the current continuous assignment, through pickup and delivery. */
export function currentTaskRoute(replay: FleetReplay, time: number, vehicleIndex: number): TaskRoute | null {
  const frame = replay.frames[time], vehicle = frame?.vehicles[vehicleIndex];
  if (!vehicle) return null;
  const orderId = taskId(vehicle);
  if (!orderId || !["available", "picked_up"].includes(frame.orderStates[orderId])) return null;
  let cursors = assignmentStarts.get(replay);
  if (!cursors) { cursors = new Map(); assignmentStarts.set(replay, cursors); }
  const previous = cursors.get(vehicleIndex);
  let start = time;
  if (previous?.orderId === orderId && (previous.time === time || previous.time === time - 1)) {
    start = previous.start;
  } else {
    // Arbitrary seeks still scan only the selected frame's past assignment.
    while (start > 0 && taskId(replay.frames[start - 1].vehicles[vehicleIndex]) === orderId &&
      ["available", "picked_up"].includes(replay.frames[start - 1].orderStates[orderId])) start--;
  }
  cursors.set(vehicleIndex, { time, orderId, start });
  const completed: GridPoint[] = [];
  for (let index = start; index <= time; index++) completed.push(point(replay.frames[index].vehicles[vehicleIndex]));
  return {
    orderId,
    completed,
    planned: decodePlannedRoute(point(vehicle), vehicle.plannedMoves ?? ""),
  };
}
