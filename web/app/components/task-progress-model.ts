import type { FleetReplay } from "./fleet-model";

export type TaskHistoryPoint = { time: number; released: number; delivered: number };

type HistoryIndex = {
  through: number;
  changes: { index: number; point: TaskHistoryPoint }[];
  orderStates?: FleetReplay["frames"][number]["orderStates"];
  released: number;
  nextRelease: number;
};
// Parsed replay tapes are immutable. Weak keys release the index when a layout
// or algorithm is unloaded; only count changes, not entire histories, are kept.
const histories = new WeakMap<FleetReplay, HistoryIndex>();

/** Index each visited frame once, without reading ahead of the selected step. */
export function taskHistory(replay: FleetReplay, time: number): TaskHistoryPoint[] {
  const end = Math.max(0, Math.min(replay.frames.length - 1, Math.floor(time)));
  if (Number.isNaN(end)) return [];
  let history = histories.get(replay);
  if (!history) {
    history = { through: -1, changes: [], released: 0, nextRelease: 0 };
    histories.set(replay, history);
  }
  for (let index = history.through + 1; index <= end; index++) {
    const frame = replay.frames[index];
    const states = frame.orderStates;
    // Compact tapes share unchanged snapshots. A release-time boundary can
    // still change visibility, so do not reuse counts across that boundary.
    if (states !== history.orderStates || frame.time >= history.nextRelease) {
      history.released = 0;
      history.nextRelease = Infinity;
      for (const order of replay.scenario.orders) {
        const releaseTime = order.releaseTime;
        if (releaseTime <= frame.time) {
          if (states[order.id] !== "pending") history.released++;
        } else {
          history.nextRelease = Math.min(history.nextRelease, releaseTime);
        }
      }
      history.orderStates = states;
    }
    const point = { time: frame.time, released: history.released, delivered: frame.completedOrders };
    const previous = history.changes.at(-1)?.point;
    if (!previous || point.released !== previous.released || point.delivered !== previous.delivered) {
      history.changes.push({ index, point });
    }
  }
  history.through = Math.max(history.through, end);
  // Binary search makes rewinding independent of the number of replay frames.
  let low = 0, high = history.changes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (history.changes[middle].index <= end) low = middle + 1;
    else high = middle;
  }
  const points = history.changes.slice(0, low).map(({ point }) => ({ ...point }));
  const last = history.changes[low - 1];
  if (last && last.index !== end) points.push({ ...last.point, time: replay.frames[end].time });
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
