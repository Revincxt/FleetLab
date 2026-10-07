import type { GridPoint } from "./maze-model";

export type WorkerState = {
  id: string;
  position: [number, number];
  activity: "walking" | "working" | "waiting";
  /** Destination cell and completed crossing substeps; position stays discrete. */
  transit?: [number, number, number];
};
export type WorkerTrafficFrame = { workers?: WorkerState[] };
export type WorkerPose = {
  position: GridPoint;
  heading: number;
  gait: number;
  work: number;
  activity: WorkerState["activity"];
  inspection?: number;
};
export type WorkerTrack = { id: string; frames: WorkerPose[] };

const distance2 = (a: GridPoint, b: GridPoint) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const blend = (a: GridPoint, b: GridPoint, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function workerPosition(worker: WorkerState, moveSteps: number): GridPoint {
  const [x, y] = worker.position;
  if (!worker.transit) return { x, y };
  const [toX, toY, progress] = worker.transit;
  return blend({ x, y }, { x: toX, y: toY }, progress / moveSteps);
}

/** Presentation only: every position and stop comes from the authoritative tape.
 * Never generate patrol routes or make collision decisions in the renderer.
 */
export function buildWorkerTracks(traffic: WorkerTrafficFrame[], moveSteps = 1): WorkerTrack[] {
  return (traffic[0]?.workers ?? []).map((initial, index) => {
    let heading = 0, walked = 0;
    let previous = workerPosition(initial, moveSteps);
    const frames = traffic.map((frame, time): WorkerPose => {
      const worker = frame.workers?.[index];
      if (!worker || worker.id !== initial.id) throw new Error("Worker replay is inconsistent.");
      const { x, y } = workerPosition(worker, moveSteps);
      const dx = x - previous.x, dy = y - previous.y;
      if (dx || dy) heading = Math.atan2(dx, dy);
      walked += Math.hypot(dx, dy);
      previous = { x, y };
      return {
        position: { x, y }, heading, gait: walked * Math.PI * 3,
        work: time * 0.23 + index * 1.7, activity: worker.activity,
      };
    });
    return { id: initial.id, frames };
  });
}

export function interpolateWorker(from: WorkerPose, to: WorkerPose, progress: number): WorkerPose {
  const t = Math.max(0, Math.min(1, progress));
  const turn = Math.atan2(Math.sin(to.heading - from.heading), Math.cos(to.heading - from.heading));
  const moving = distance2(from.position, to.position) > 0;
  return {
    position: blend(from.position, to.position, t),
    heading: from.heading + turn * t * t * (3 - 2 * t),
    gait: from.gait + (to.gait - from.gait) * t,
    work: from.work + (to.work - from.work) * t,
    inspection: Number(from.activity === "working") + (Number(to.activity === "working") - Number(from.activity === "working")) * t * t * (3 - 2 * t),
    activity: t < 1 && moving ? "walking" : to.activity,
  };
}
