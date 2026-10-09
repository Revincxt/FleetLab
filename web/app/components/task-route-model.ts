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
  let start = time;
  while (start > 0 && taskId(replay.frames[start - 1].vehicles[vehicleIndex]) === orderId &&
    ["available", "picked_up"].includes(replay.frames[start - 1].orderStates[orderId])) start--;
  return {
    orderId,
    completed: replay.frames.slice(start, time + 1).map(frame => point(frame.vehicles[vehicleIndex])),
    planned: decodePlannedRoute(point(vehicle), vehicle.plannedMoves ?? ""),
  };
}
