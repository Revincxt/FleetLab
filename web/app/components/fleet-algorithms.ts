export const fleetAlgorithms = [
  { id: "coordinated-astar", label: "Coordinated A*", file: "./fleet-demo.json" },
  { id: "whca", label: "WHCA*", file: "./fleet-whca.json" },
  { id: "rhcr-pbs", label: "RHCR + PBS", file: "./fleet-rhcr-pbs.json" },
] as const;

export type FleetAlgorithmId = (typeof fleetAlgorithms)[number]["id"];

export function fleetAlgorithm(id: string | null) {
  return fleetAlgorithms.find((item) => item.id === id) ?? fleetAlgorithms[0];
}
