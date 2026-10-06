import { fleetAlgorithms, type FleetAlgorithmId } from "./fleet-algorithms";
import { Icon } from "./ui-icon";

export function AlgorithmPicker({ value, loading, onChange }: {
  value: FleetAlgorithmId; loading: boolean; onChange: (id: FleetAlgorithmId) => void;
}) {
  return <label className="algorithm-picker">
    <span className="sr-only">Planning algorithm</span>
    <select value={value} disabled={loading} onChange={(event) => onChange(event.target.value as FleetAlgorithmId)}>
      {fleetAlgorithms.map((algorithm) => <option key={algorithm.id} value={algorithm.id}>{algorithm.label}</option>)}
    </select>
    <Icon name="arrow" />
  </label>;
}
