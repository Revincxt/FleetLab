import type { FleetEvent, VehicleState } from "./fleet-model";
import type { MazeOrderState } from "./maze-model";

export const eventLabels: Record<FleetEvent["kind"], string> = {
  order_arrival: "Task released", cell_blocked: "Cell blocked", cell_unblocked: "Cell reopened",
};

export const orderLabels: Record<MazeOrderState, string> = {
  queued: "Scheduled", ready: "Awaiting pickup", carried: "In transit", delivered: "Delivered", expired: "Expired",
};

export const gridCellHint = "Recorded grid position (x, y). Movement between cells is visually interpolated, not continuous-space simulation.";
export const simulationStepHint = "Discrete simulation step, not elapsed seconds. Playback speed only changes the animation rate.";

/** Describe what the recorded frame proves, without inventing the vehicle's target. */
export function vehicleStatusLabel(vehicle: VehicleState) {
  if (vehicle.action === "pickup" && vehicle.carriedOrderId) return "Loaded";
  if (vehicle.action === "dropoff" && vehicle.deliveredOrderId) return "Delivered";
  if (vehicle.status === "complete") return "Finished";
  if (vehicle.status === "yielding") return "Yielding";
  if (vehicle.action === "charge") return "Charging";
  if (vehicle.action === "wait") return vehicle.carriedOrderId || vehicle.assignedOrderId ? "Waiting" : "Idle";
  if (vehicle.carriedOrderId) return "In transit";
  // An assigned forklift may detour to a charger; the tape does not expose its goal.
  if (vehicle.assignedOrderId) return "Assigned";
  return ["up", "down", "left", "right"].includes(vehicle.action) ? "Repositioning" : "Idle";
}

export function vehicleStatusHint(vehicle: VehicleState) {
  const label = vehicleStatusLabel(vehicle);
  const hints: Record<string, string> = {
    Loaded: "Loading completed at this step; cargo is on the forks.",
    Delivered: "Unloading completed at this step; the forks are empty.",
    Assigned: "A task is assigned, but cargo has not been loaded. The current route may include a charging stop.",
    "In transit": "Carrying cargo; delivery has not completed.",
    Repositioning: "Moving without an assigned task or cargo.",
    Yielding: "Waiting for another vehicle to clear a reserved cell.",
    Charging: "Charging at a charging station.",
    Waiting: "Waiting with an assigned task or loaded cargo.",
    Idle: "No task or cargo is being handled.",
    Finished: "This recorded simulation has ended.",
  };
  return hints[label];
}

export const statusColors = {
  idle: "#8e9ca7", working: "#79cdd3", charging: "#c9ee96",
  waiting: "#e7b981", complete: "#9cd1b6", alert: "#ee9688",
} as const;
export const statusToneHints = {
  idle: "Idle", working: "Working", charging: "Charging",
  waiting: "Waiting or yielding", complete: "Finished", alert: "Constraint violation",
} as const;
export type StatusTone = keyof typeof statusColors;

/** State colors are independent of the permanent per-vehicle map colors. */
export function vehicleStatusTone(vehicle: VehicleState): StatusTone {
  if (vehicle.violations.length) return "alert";
  switch (vehicleStatusLabel(vehicle)) {
    case "Charging": return "charging";
    case "Waiting": case "Yielding": return "waiting";
    case "Loaded": case "Assigned": case "In transit": case "Repositioning": return "working";
    case "Delivered": case "Finished": return "complete";
    default: return "idle";
  }
}

export function fleetStatusTone(vehicles: VehicleState[]): StatusTone {
  const tones = vehicles.map(vehicleStatusTone);
  // Surface attention states before general activity. Only call the fleet finished
  // when all vehicles have finished, not when one vehicle delivers a task.
  for (const tone of ["alert", "waiting", "working", "charging"] as const) {
    if (tones.includes(tone)) return tone;
  }
  return vehicles.length && vehicles.every(vehicle => vehicle.status === "complete") ? "complete" : "idle";
}

export const batteryColors = {
  healthy: "#9cd1b6", warning: "#e7b981", critical: "#ee9688", charging: "#c9ee96",
} as const;
export const batteryToneHints = {
  healthy: "Battery above 40%", warning: "Battery between 21% and 40%",
  critical: "Low battery: 20% or less", charging: "Charging at this step",
} as const;

export function vehicleBatteryTone(vehicle: VehicleState, capacity: number): keyof typeof batteryColors {
  const percent = Math.round(vehicle.battery / capacity * 100);
  // Low battery stays visible even while charging. Never use vehicle identity colors.
  if (percent <= 20) return "critical";
  if (vehicle.action === "charge" && !vehicle.violations.length) return "charging";
  return percent <= 40 ? "warning" : "healthy";
}
