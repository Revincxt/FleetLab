from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from adaptive_agent_lab.environment.contracts import Action, Position
from adaptive_agent_lab.reporting.artifacts import (
    canonical_json,
    fingerprint,
    read_json,
    write_json_atomic,
)


class ArtifactTests(unittest.TestCase):
    def test_canonical_json_and_fingerprint_ignore_mapping_order(self) -> None:
        left = {"b": 2, "a": 1}
        right = {"a": 1, "b": 2}
        self.assertEqual(canonical_json(left), canonical_json(right))
        self.assertEqual(fingerprint(left), fingerprint(right))

    def test_atomic_json_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested" / "artifact.json"
            write_json_atomic(path, {"seed": 42, "agent": "dyna-q"})
            self.assertEqual(read_json(path), {"agent": "dyna-q", "seed": 42})
            self.assertFalse(path.with_name(".artifact.json.tmp").exists())

    def test_compact_atomic_json_omits_only_presentation_whitespace(self) -> None:
        value = {"label": "keep spaces inside values", "rows": [{"value": 42}, None]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "compact.json"
            write_json_atomic(path, value, indent=None)
            self.assertEqual(path.read_text(), canonical_json(value) + "\n")
            self.assertEqual(read_json(path), value)
            self.assertFalse(path.with_name(".compact.json.tmp").exists())

    def test_default_encoder_supports_domain_values_and_paths(self) -> None:
        encoded = canonical_json(
            {
                "action": Action.WAIT,
                "coordinate": Position(2, 3),
                "path": Path("runs/example.json"),
                "sequence": (1, 2),
                "tags": frozenset({"evaluation"}),
            }
        )
        self.assertEqual(
            encoded,
            '{"action":"wait","coordinate":{"x":2,"y":3},'
            '"path":"runs/example.json","sequence":[1,2],"tags":["evaluation"]}',
        )

    def test_default_encoder_rejects_unknown_objects_and_non_finite_values(self) -> None:
        with self.assertRaises(TypeError):
            canonical_json(object())
        with self.assertRaises(ValueError):
            canonical_json({"loss": float("nan")})

if __name__ == "__main__":
    unittest.main()
