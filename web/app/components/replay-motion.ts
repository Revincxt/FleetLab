import type { GridPoint } from "./maze-model";

export type RobotMotion = {
  from: GridPoint;
  to: GridPoint;
  fromHeading: number;
  turn: number;
  startedAt: number;
  duration: number;
};

/** Presentation only: follow the recorded grid edge without rounding across aisles. */
export function createRobotMotion(from: GridPoint, to: GridPoint, heading: number, startedAt: number, duration: number): RobotMotion {
  const targetHeading = Math.atan2(to.x - from.x, to.y - from.y);
  const delta = targetHeading - heading;
  return {
    from: { ...from }, to: { ...to }, fromHeading: heading,
    turn: Math.atan2(Math.sin(delta), Math.cos(delta)),
    startedAt, duration: Math.max(1, duration),
  };
}

export function sampleRobotMotion(motion: RobotMotion, now: number) {
  const progress = Math.max(0, Math.min(1, (now - motion.startedAt) / motion.duration));
  // Constant translation speed avoids braking and waiting at every grid cell.
  // Only the chassis heading eases into the new direction along the shortest arc.
  const turnProgress = Math.min(1, progress / 0.6);
  const easedTurn = turnProgress * turnProgress * (3 - 2 * turnProgress);
  return {
    position: {
      x: motion.from.x + (motion.to.x - motion.from.x) * progress,
      y: motion.from.y + (motion.to.y - motion.from.y) * progress,
    },
    heading: motion.fromHeading + motion.turn * easedTurn,
    progress,
    complete: progress === 1,
  };
}

/** Change the remaining playback time without jumping the position or heading. */
export function retimeRobotMotion(motion: RobotMotion, now: number, remainingDuration: number): RobotMotion {
  const { progress } = sampleRobotMotion(motion, now);
  if (progress === 1) return motion;
  const duration = Math.max(1, remainingDuration) / (1 - progress);
  return { ...motion, startedAt: now - progress * duration, duration };
}
