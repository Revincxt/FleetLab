import type { FleetNotice } from "./fleet-notice-model";

export type GridPoint = { x: number; y: number };
export type MazeOrderState = "queued" | "ready" | "carried" | "delivered" | "expired";

export function isOrderMarkerVisible(state: MazeOrderState | undefined) {
  return state === "ready" || state === "carried";
}

/** Pickup is no longer a destination once the load is on a forklift. */
export function isOrderEndpointVisible(state: MazeOrderState | undefined, endpoint: number) {
  return isOrderMarkerVisible(state) && (endpoint === 1 || state === "ready");
}

export type MazeScenario = {
  width: number;
  height: number;
  obstacles: GridPoint[];
  chargingStations: GridPoint[];
  orders: { id: string; pickup: GridPoint; dropoff: GridPoint }[];
};

export type MazeRobot = {
  id: string;
  label?: string;
  position: GridPoint;
  color: string;
  complete: boolean;
  carrying?: boolean;
};

export type MazeFrame = {
  time: number;
  animate: boolean;
  stepDuration?: number;
  fleet: MazeRobot[];
  primary: MazeRobot;
  routes: Record<string, TaskRoute | null>;
  notices: FleetNotice[];
  blocked: GridPoint[];
  orderStates: MazeOrderState[];
  orderColors?: (string | null)[];
  highlightedOrderId?: string | null;
  description: string;
};

export type TaskRoute = { orderId: string; completed: GridPoint[]; planned: GridPoint[] };

export function shouldAnimateFleetMove(previous: MazeFrame | null, next: MazeFrame, id: string) {
  const before = previous?.fleet.find((robot) => robot.id === id);
  const after = next.fleet.find((robot) => robot.id === id);
  return Boolean(next.animate && previous && next.time === previous.time + 1 &&
    before && after && isAdjacent(before.position, after.position));
}

export type RouteSegment = { from: GridPoint; to: GridPoint };

/** Three stationary dashes per grid edge; clip the moving edge at the vehicle. */
export function dashedRouteSegments(segments: RouteSegment[], clip = 0): RouteSegment[] {
  return segments.flatMap(({ from, to }) => {
    const result: RouteSegment[] = [];
    for (let index = 0; index < 3; index++) {
      const start = Math.max(index / 3, clip), end = index / 3 + 0.21;
      if (start >= end) continue;
      const at = (t: number) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
      result.push({ from: at(start), to: at(end) });
    }
    return result;
  });
}

/** A solid grid trail needs at most one instance per undirected edge and cell. */
export function routeCapacity(width: number, height: number) {
  return { segments: (width - 1) * height + (height - 1) * width, joints: width * height };
}

/** Grid x/y becomes scene x/z. Elevation is visual, never simulator state. */
export function toWorld(point: GridPoint, width: number, height: number, elevation = 0) {
  return {
    x: point.x - (width - 1) / 2,
    y: elevation,
    z: point.y - (height - 1) / 2,
  };
}

export function isAdjacent(from: GridPoint, to: GridPoint) {
  return Math.abs(from.x - to.x) + Math.abs(from.y - to.y) === 1;
}

/** Skip waits, repeated edges, and discontinuities rather than draw false paths. */
export function routeSegments(points: GridPoint[]): RouteSegment[] {
  const segments: RouteSegment[] = [];
  const seen = new Set<string>();
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1];
    const to = points[index];
    if (!isAdjacent(from, to)) continue;
    const edge = [`${from.x}:${from.y}`, `${to.x}:${to.y}`].sort().join("|");
    if (seen.has(edge)) continue;
    seen.add(edge);
    segments.push({ from, to });
  }
  return segments;
}

/** Reveal only the current edge behind the moving vehicle, never ahead of it. */
export function progressiveRoute(points: GridPoint[], moving: boolean): { segments: RouteSegment[]; tip: RouteSegment | null } {
  const from = points.at(-2);
  const to = points.at(-1);
  if (!moving || !from || !to || !isAdjacent(from, to)) {
    return { segments: routeSegments(points), tip: null };
  }
  const segments = routeSegments(points.slice(0, -1));
  const same = (a: GridPoint, b: GridPoint) => a.x === b.x && a.y === b.y;
  const visited = segments.some((edge) =>
    same(edge.from, from) && same(edge.to, to) || same(edge.from, to) && same(edge.to, from)
  );
  return { segments, tip: visited ? null : { from, to } };
}
