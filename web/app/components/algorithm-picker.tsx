import { fleetAlgorithms, type FleetAlgorithmId } from "./fleet-algorithms";
import { CompactPicker } from "./compact-picker";

const algorithmOptions = fleetAlgorithms.map((algorithm) => ({ value: algorithm.id, label: algorithm.label }));

export function AlgorithmPicker({ value, loading, onChange }: {
  value: FleetAlgorithmId; loading: boolean; onChange: (id: FleetAlgorithmId) => void;
}) {
  return <CompactPicker className="algorithm-picker" label="Planning algorithm"
    value={value} disabled={loading} options={algorithmOptions} onChange={onChange} />;
}
