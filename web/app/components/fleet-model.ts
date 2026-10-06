import type { GridPoint, MazeOrderState } from "./maze-model";

export type FleetOrder = { id: string; pickup: GridPoint; dropoff: GridPoint; releaseTime: number; deadline: number; priority: number };
export type FleetEvent = { time: number; kind: "order_arrival" | "cell_blocked" | "cell_unblocked"; position?: GridPoint; orderId?: string };
export type FleetVehicle = { id: string; label: string; badge: string; color: string; initialPosition: GridPoint };
export type VehicleState = {
  id: string; position: [number, number]; battery: number; action: string; requestedAction: string;
  status: "standby" | "returning" | "collecting" | "delivering" | "charging" | "waiting" | "yielding" | "complete";
  carriedOrderId: string | null; assignedOrderId: string | null; deliveredOrderId: string | null;
  violations: string[]; distance: number; deliveredOrders: number; trafficWaits: number; constraintViolations: number;
};
export type FleetFrame = {
  time: number; vehicles: VehicleState[];
  orderStates: Record<string, "pending" | "available" | "picked_up" | "delivered" | "expired">;
  blocked: GridPoint[]; completedOrders: number; terminated: boolean;
};
export type FleetReplay = {
  schemaVersion: 1; kind: "fleet-replay"; controller: string; verificationStatus: string;
  scenario: { id: string; width: number; height: number; horizon: number; batteryCapacity: number;
    obstacles: GridPoint[]; chargingStations: GridPoint[]; orders: FleetOrder[]; events: FleetEvent[] };
  vehicles: FleetVehicle[]; frames: FleetFrame[];
  summary: { steps: number; completedOrders: number; totalOrders: number; distance: number; trafficWaits: number; constraintViolations: number };
};
export type FleetCase = FleetReplay & { caseId: string; label: string };
export type FleetGallery = { schemaVersion: 1; kind: "fleet-gallery"; defaultCaseId: string; cases: FleetCase[] };

const orderStateCodes = ["pending", "available", "picked_up", "delivered", "expired"] as const;

/** Normalize compact schema 2 without mutating its input or exposing future states. */
function decodeOrderStates(value: unknown): unknown {
  const raw = value as { schemaVersion?: number; scenario?: { orders?: { id: string }[] }; frames?: { orderStates?: unknown }[] } | null;
  if (raw?.schemaVersion !== 2) return value;
  const orders = raw.scenario?.orders;
  if (!Array.isArray(orders) || orders.some(order => !order || typeof order.id !== "string") || !Array.isArray(raw.frames)) {
    throw new Error("Compact fleet replay data is invalid.");
  }
  let previousCodes: string | undefined;
  let previousStates: FleetFrame["orderStates"] = {};
  const frames = raw.frames.map(frame => {
    const codes = frame?.orderStates;
    if (typeof codes !== "string" || codes.length !== orders.length || /[^0-4]/.test(codes)) {
      throw new Error("Compact fleet task states are invalid.");
    }
    // Unchanged snapshots can share a state map; changed snapshots get a new
    // object so seeking backwards can never reveal later releases/deliveries.
    if (codes !== previousCodes) {
      previousStates = Object.fromEntries(orders.map((order, index) => [order.id, orderStateCodes[Number(codes[index])]]));
      previousCodes = codes;
    }
    return { ...frame, orderStates: previousStates };
  });
  return { ...raw, schemaVersion: 1, frames };
}

export function parseFleetGallery(value: unknown, expectedController?: string): FleetGallery {
  const gallery = value as (Omit<FleetGallery, "schemaVersion"> & { schemaVersion: number }) | null;
  if (!gallery || ![1, 2].includes(gallery.schemaVersion) || gallery.kind !== "fleet-gallery" || !Array.isArray(gallery.cases) || !gallery.cases.length) {
    throw new Error("Fleet gallery data is invalid or unsupported.");
  }
  const ids = new Set<string>();
  const cases = gallery.cases.map(item => {
    if (!item || typeof item.caseId !== "string" || !item.caseId || ids.has(item.caseId) || typeof item.label !== "string" || !item.label) {
      throw new Error("Fleet layout identifiers are invalid.");
    }
    ids.add(item.caseId);
    if (expectedController && item.controller !== expectedController) {
      throw new Error("Fleet replay does not match the selected algorithm.");
    }
    return { ...parseFleetReplay(item), caseId: item.caseId, label: item.label };
  });
  if (!ids.has(gallery.defaultCaseId)) throw new Error("Default fleet layout is missing.");
  return { ...gallery, schemaVersion: 1, cases };
}

/** Reject incompatible or corrupt tapes before handing coordinates to WebGL. */
export function parseFleetReplay(value: unknown): FleetReplay {
  const replay = decodeOrderStates(value) as FleetReplay | null;
  const fail = () => { throw new Error("Fleet replay data is invalid or unsupported."); };
  if (!replay || replay.schemaVersion !== 1 || replay.kind !== "fleet-replay" ||
    !Array.isArray(replay.vehicles) || replay.vehicles.length < 2 ||
    !Array.isArray(replay.frames) || replay.frames.length < 2 || !replay.scenario) return fail();
  const { scenario, vehicles, frames } = replay;
  if (!Number.isInteger(scenario.width) || scenario.width <= 0 ||
    !Number.isInteger(scenario.height) || scenario.height <= 0 ||
    !Number.isInteger(scenario.batteryCapacity) || scenario.batteryCapacity <= 0 ||
    !Array.isArray(scenario.obstacles) || !Array.isArray(scenario.orders) ||
    !Array.isArray(scenario.chargingStations) || !Array.isArray(scenario.events)) return fail();
  const ids = vehicles.map((vehicle) => vehicle.id);
  if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) return fail();
  const orderIds = scenario.orders.map((order) => order.id);
  const obstacles = new Set(scenario.obstacles.map(({ x, y }) => `${x}:${y}`));
  const statuses = new Set(["pending", "available", "picked_up", "delivered", "expired"]);
  for (const [time, frame] of frames.entries()) {
    if (frame.time !== time || !Array.isArray(frame.vehicles) || frame.vehicles.length !== ids.length ||
      !frame.orderStates || Object.keys(frame.orderStates).length !== orderIds.length ||
      orderIds.some((id) => !statuses.has(frame.orderStates[id])) || !Array.isArray(frame.blocked)) return fail();
    const occupied = new Set<string>();
    const carried = new Set<string>();
    for (const [index, vehicle] of frame.vehicles.entries()) {
      if (vehicle.id !== ids[index] || !Array.isArray(vehicle.position) || vehicle.position.length !== 2) return fail();
      const [x, y] = vehicle.position;
      const key = `${x}:${y}`;
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= scenario.width || y >= scenario.height ||
        obstacles.has(key) || occupied.has(key) || !Number.isInteger(vehicle.battery) ||
        vehicle.battery < 0 || vehicle.battery > scenario.batteryCapacity) return fail();
      occupied.add(key);
      if (vehicle.carriedOrderId) {
        if (carried.has(vehicle.carriedOrderId) || frame.orderStates[vehicle.carriedOrderId] !== "picked_up") return fail();
        carried.add(vehicle.carriedOrderId);
      }
    }
    if (Object.values(frame.orderStates).filter((status) => status === "picked_up").length !== carried.size ||
      Object.values(frame.orderStates).filter((status) => status === "delivered").length !== frame.completedOrders) return fail();
  }
  if (!frames.at(-1)?.terminated || replay.summary?.steps !== frames.length - 1 ||
    replay.summary.completedOrders !== frames.at(-1)?.completedOrders) return fail();
  return replay;
}

export function displayedOrderState(state: FleetFrame["orderStates"][string]): MazeOrderState {
  return state === "pending" ? "queued" : state === "available" ? "ready" : state === "picked_up" ? "carried" : state;
}

export function vehiclePoint(vehicle: VehicleState): GridPoint {
  return { x: vehicle.position[0], y: vehicle.position[1] };
}

/** Occupancy is recorded position, not a reservation or an inferred destination. */
export function chargingStationState(station: GridPoint, frame: FleetFrame) {
  const vehicle = frame.vehicles.find(({ position }) => position[0] === station.x && position[1] === station.y) ?? null;
  const status = !vehicle ? "unoccupied"
    : vehicle.action === "charge" && !vehicle.violations.length ? "charging" : "occupied";
  return { vehicle, status };
}

/** Frames record completed actions: pickup attaches cargo; successful dropoff clears it. */
export function isVehicleLoaded(vehicle: Pick<VehicleState, "carriedOrderId">) {
  // Assignment, movement, waiting or charging alone must never create or hide cargo.
  return Boolean(vehicle.carriedOrderId);
}

/** Keep future orders out of every queue, count, and selection until release. */
export function releasedOrderEntries(orders: FleetOrder[], frame: FleetFrame) {
  return orders.map((order, index) => ({ order, index })).filter(({ order }) =>
    order.releaseTime <= frame.time && frame.orderStates[order.id] !== "pending"
  );
}
