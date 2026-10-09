import type { FleetReplay, VehicleState } from "./fleet-model";

export type FleetNotice = {
  id: string;
  vehicleId: string;
  orderId: string;
  step: number;
  kind: "route" | "pickup" | "delivery";
};

export const noticeCopy = {
  route: "Rerouting",
  pickup: "Picked up",
  delivery: "Delivered",
};
export const NOTICE_DURATION = 1200;
const taskId = (vehicle: VehicleState) => vehicle.carriedOrderId ?? vehicle.assignedOrderId;
const spatialMoves = (vehicle: VehicleState) => vehicle.plannedMoves?.replaceAll(".", "") ?? "";
const samePosition = (a: VehicleState, b: VehicleState) => a.position[0] === b.position[0] && a.position[1] === b.position[1];

/** Compare the shared spatial plan, not consumed moves, waits or a longer window. */
function routeChanged(replay: FleetReplay, time: number, index: number) {
  const current = replay.frames[time].vehicles[index];
  const orderId = taskId(current), next = spatialMoves(current);
  if (!orderId || !next || !["available", "picked_up"].includes(replay.frames[time].orderStates[orderId])) return false;
  for (let at = time - 1; at >= 0; at--) {
    const before = replay.frames[at].vehicles[index];
    if (before.id !== current.id || taskId(before) !== orderId || before.carriedOrderId !== current.carriedOrderId || before.plannedMoves === undefined) return false;
    let previous = spatialMoves(before);
    if (!previous) {
      // Retain the last known route across stationary traffic waits.
      if (!samePosition(before, current)) return false;
      continue;
    }
    if (!samePosition(before, current)) {
      const delta: Record<string, [number, number]> = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
      const [dx, dy] = delta[previous[0]];
      if (before.position[0] + dx !== current.position[0] || before.position[1] + dy !== current.position[1]) return true;
      previous = previous.slice(1);
    }
    const shared = Math.min(previous.length, next.length);
    return previous.slice(0, shared) !== next.slice(0, shared);
  }
  return false;
}

/** Events use successful recorded transitions only; never infer a cause for a reroute. */
export function fleetNoticesAt(replay: FleetReplay, time: number): FleetNotice[] {
  const frame = replay.frames[time], previous = replay.frames[time - 1];
  if (!frame || !previous) return [];
  return frame.vehicles.flatMap((vehicle, index) => {
    const before = previous.vehicles[index];
    if (!before || before.id !== vehicle.id) return [];
    let kind: FleetNotice["kind"], orderId: string;
    if (vehicle.deliveredOrderId && before.carriedOrderId === vehicle.deliveredOrderId && frame.orderStates[vehicle.deliveredOrderId] === "delivered") {
      kind = "delivery"; orderId = vehicle.deliveredOrderId;
    } else if (vehicle.carriedOrderId && vehicle.carriedOrderId !== before.carriedOrderId && frame.orderStates[vehicle.carriedOrderId] === "picked_up") {
      kind = "pickup"; orderId = vehicle.carriedOrderId;
    } else if (routeChanged(replay, time, index)) {
      kind = "route"; orderId = taskId(vehicle)!;
    } else return [];
    return [{ id: `${time}:${vehicle.id}:${kind}:${orderId}`, vehicleId: vehicle.id, orderId, step: time, kind }];
  });
}

export type ActiveNotice = { notice: FleetNotice; expiresAt: number };
type NoticeSlot = { active: ActiveNotice | null; pending: { notice: FleetNotice; queuedAt: number }[]; lastRouteAt: number };

/** One bubble per vehicle; task milestones take precedence over noisy reroutes. */
export class FleetNoticeBoard {
  private time: number | null = null;
  private readonly slots = new Map<string, NoticeSlot>();

  reset() { this.time = null; this.slots.clear(); }

  step(time: number, notices: FleetNotice[], now: number) {
    const sequential = this.time !== null && time === this.time + 1;
    if (this.time === null || (time !== this.time && !sequential)) this.reset();
    this.time = time;
    this.shown(now);
    if (!sequential) return;
    for (const notice of notices) {
      let slot = this.slots.get(notice.vehicleId);
      if (!slot) {
        slot = { active: null, pending: [], lastRouteAt: -Infinity };
        this.slots.set(notice.vehicleId, slot);
      }
      if (slot.active?.notice.id === notice.id || slot.pending.some(item => item.notice.id === notice.id)) continue;
      if (notice.kind === "route") {
        if (now - slot.lastRouteAt < 4000 || slot.active?.notice.kind === "route") continue;
        slot.lastRouteAt = now;
        slot.pending = slot.pending.filter(item => item.notice.kind !== "route");
      } else {
        slot.pending = slot.pending.filter(item => item.notice.kind !== "route");
        if (slot.active?.notice.kind === "route") slot.active = null;
      }
      if (!slot.active) slot.active = { notice, expiresAt: now + NOTICE_DURATION };
      else slot.pending = [...slot.pending, { notice, queuedAt: now }].slice(-3);
    }
  }

  shown(now: number): ActiveNotice[] {
    const active: ActiveNotice[] = [];
    for (const slot of this.slots.values()) {
      slot.pending = slot.pending.filter(item => now - item.queuedAt < 7000);
      if (slot.active && now >= slot.active.expiresAt) slot.active = null;
      if (!slot.active && slot.pending.length) {
        const item = slot.pending.shift()!;
        slot.active = { notice: item.notice, expiresAt: now + NOTICE_DURATION };
      }
      if (slot.active) active.push(slot.active);
    }
    return active;
  }
}

export type NoticeAnchor = { vehicleId: string; label: string; color: string; x: number; y: number; width?: number };
export const NOTICE_WIDTH = 128;
export const NOTICE_HEIGHT = 28;

/** Keep nearby speech bubbles apart without moving their actual vehicle anchors. */
export function layoutNotices(anchors: NoticeAnchor[], width: number, height: number) {
  const placed: { x: number; y: number; width: number }[] = [];
  const clampY = (y: number) => Math.max(NOTICE_HEIGHT + 8, Math.min(height - 8, y));
  return anchors.map(anchor => {
    const bubbleWidth = Math.min(anchor.width ?? NOTICE_WIDTH, Math.max(1, width - 16));
    const clampX = (x: number) => Math.max(bubbleWidth / 2 + 8, Math.min(width - bubbleWidth / 2 - 8, x));
    const origin = { x: clampX(anchor.x), y: clampY(anchor.y - 6) };
    let position = origin;
    search: for (const dx of [0, -(bubbleWidth + 8), bubbleWidth + 8]) {
      for (const row of [0, -1, -2, -3, 1, 2, 3]) {
        const candidate = { x: clampX(origin.x + dx), y: clampY(origin.y + row * (NOTICE_HEIGHT + 8)) };
        if (placed.every(other => Math.abs(candidate.x - other.x) >= (bubbleWidth + other.width) / 2 + 6 || Math.abs(candidate.y - other.y) >= NOTICE_HEIGHT + 6)) {
          position = candidate;
          break search;
        }
      }
    }
    placed.push({ ...position, width: bubbleWidth });
    return { ...anchor, bubbleX: position.x, bubbleY: position.y, width: bubbleWidth };
  });
}
