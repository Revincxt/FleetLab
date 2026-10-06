import type { FleetReplay } from "./fleet-model";

export type TaskHistoryPoint = { time: number; released: number; delivered: number };

/** Keep every count change, but never expose frames beyond the selected step. */
export function taskHistory(replay: FleetReplay, time: number): TaskHistoryPoint[] {
  const end = Math.max(0, Math.min(replay.frames.length - 1, Math.floor(time)));
  const points: TaskHistoryPoint[] = [];
  for (let index = 0; index <= end; index++) {
    const frame = replay.frames[index];
    const released = replay.scenario.orders.filter((order) => order.releaseTime <= frame.time && frame.orderStates[order.id] !== "pending").length;
    const point = { time: frame.time, released, delivered: frame.completedOrders };
    const previous = points.at(-1);
    if (!previous || point.released !== previous.released || point.delivered !== previous.delivered || index === end) points.push(point);
  }
  return points;
}

/** Four evenly spaced, integer-count intervals; zero data still has a valid scale. */
export function chartCeiling(value: number) {
  const unit = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(1, value) / 4)));
  return Math.max(4, Math.ceil(value / (4 * unit)) * 4 * unit);
}

/** Counts change at recorded steps, not along an interpolated or smoothed curve. */
export function taskStepPath(points: TaskHistoryPoint[], key: "released" | "delivered", maximum: number) {
  const end = Math.max(1, points.at(-1)?.time ?? 0);
  return points.map((point, index) => {
    const x = +(point.time / end * 1000).toFixed(3);
    const y = +(240 - point[key] / maximum * 240).toFixed(3);
    return index ? `H${x}V${y}` : `M${x},${y}h0.01`;
  }).join("");
}

/** Close the recorded staircase at zero; a single instant has no area. */
export function taskAreaPath(points: TaskHistoryPoint[], key: "released" | "delivered", maximum: number) {
  if (points.length < 2 || points[points.length - 1].time <= points[0].time) return "";
  return `${taskStepPath(points, key, maximum)}L1000,240H0Z`;
}
