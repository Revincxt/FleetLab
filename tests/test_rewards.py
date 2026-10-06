from __future__ import annotations

import json
import unittest
from pathlib import Path

from adaptive_agent_lab.environment.rewards import RewardScheme


class RewardTests(unittest.TestCase):
    def test_reference_configs_only_declare_applied_reward_terms(self) -> None:
        expected = RewardScheme().as_dict()
        self.assertEqual(len(expected), 7)
        self.assertNotIn("stranded_cost", expected)
        root = Path(__file__).resolve().parents[1] / "configs/training"
        configs = sorted(root.glob("*.json"))
        self.assertEqual(len(configs), 4)
        for path in configs:
            with self.subTest(config=path.name):
                self.assertEqual(json.loads(path.read_text())["reward"], expected)

    def test_on_time_delivery_receives_priority_scaled_bonus(self) -> None:
        rewards = RewardScheme()
        self.assertEqual(rewards.delivery(priority=2.0, completion_time=8, deadline=8), 30.0)

    def test_late_delivery_uses_elapsed_lateness_not_priority(self) -> None:
        rewards = RewardScheme()
        self.assertEqual(rewards.delivery(priority=2.0, completion_time=13, deadline=10), 19.4)

    def test_invalid_priority_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            RewardScheme().delivery(priority=0.0, completion_time=0, deadline=0)


if __name__ == "__main__":
    unittest.main()
