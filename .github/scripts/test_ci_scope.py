from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

from ci_scope import changed_paths, classify


class ScopeTests(unittest.TestCase):
    def test_frontend_only_does_not_repeat_simulations(self) -> None:
        for path in ("web/app/globals.css", "web/package.json", "web/pnpm-lock.yaml"):
            with self.subTest(path=path):
                self.assertEqual(classify([path]), {
                    "python": False, "frontend": True, "package": False,
                })

    def test_simulator_and_recorded_data_require_python_checks(self) -> None:
        for path in (
            "src/adaptive_agent_lab/agents/planning.py", "tests/test_fleet.py",
            "scenarios/medium/maze-warehouse.json", "configs/fleet-demo.json",
            "web/public/fleet-whca.json",
        ):
            with self.subTest(path=path):
                self.assertTrue(classify([path])["python"])
        self.assertTrue(classify(["web/public/fleet-demo.json"])["frontend"])
        self.assertTrue(classify(["src/adaptive_agent_lab/cli.py"])["package"])

    def test_documentation_and_benchmark_assets_keep_their_checks(self) -> None:
        self.assertEqual(classify(["README.md"]), {
            "python": False, "frontend": True, "package": True,
        })
        self.assertTrue(classify(["docs/assets/replay-explorer.png"])["frontend"])
        self.assertTrue(classify(["configs/benchmarks/main.json"])["frontend"])
        self.assertTrue(classify(["LICENSE"])["package"])

    def test_unknown_inputs_and_workflow_changes_run_everything(self) -> None:
        for paths in (None, [".github/workflows/pages.yml"], ["pyproject.toml"],
                      [".github/scripts/ci_scope.py"], ["new-input.dat"]):
            with self.subTest(paths=paths):
                self.assertTrue(all(classify(paths).values()))
        self.assertFalse(any(classify([]).values()))

    @patch("ci_scope.subprocess.run")
    def test_push_and_pr_use_the_complete_diff_including_deleted_paths(self, run) -> None:
        base = "a" * 40
        run.return_value.stdout = b"web/app/globals.css\0src/removed.py\0"
        for name, event in (
            ("push", {"before": base}),
            ("pull_request", {"pull_request": {"base": {"sha": base}}}),
        ):
            paths = changed_paths(name, event)
            self.assertEqual(paths, ["web/app/globals.css", "src/removed.py"])
            self.assertTrue(all(classify(paths).values()))
            self.assertEqual(run.call_args.args[0][-2:], [base, "HEAD"])
            self.assertIn("--no-renames", run.call_args.args[0])

    @patch("ci_scope.subprocess.run")
    def test_missing_base_fetch_errors_and_manual_runs_do_not_skip_checks(self, run) -> None:
        for name, event in (("workflow_dispatch", {}), ("push", {"before": "0" * 40}),
                            ("push", {}), ("pull_request", {})):
            self.assertIsNone(changed_paths(name, event))
        run.assert_not_called()
        run.side_effect = subprocess.CalledProcessError(1, "git")
        with patch("builtins.print") as warning:
            self.assertIsNone(changed_paths("push", {"before": "a" * 40}))
        warning.assert_called_once()


if __name__ == "__main__":
    unittest.main()
