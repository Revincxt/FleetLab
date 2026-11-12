from __future__ import annotations

import unittest

from adaptive_agent_lab.randomness import derive_seed


class RandomnessTests(unittest.TestCase):
    def test_seed_derivation_is_stable_and_namespaced(self) -> None:
        self.assertEqual(derive_seed(42, "scenario", 1), derive_seed(42, "scenario", 1))
        self.assertNotEqual(derive_seed(42, "scenario", 1), derive_seed(42, "events", 1))

    def test_negative_root_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            derive_seed(-1, "agent")

if __name__ == "__main__":
    unittest.main()
