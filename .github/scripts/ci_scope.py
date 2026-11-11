"""Select checks from the complete push/PR diff; uncertainty runs every check."""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path


def classify(paths: list[str] | None) -> dict[str, bool]:
    scopes = dict.fromkeys(("python", "frontend", "package"), False)
    if paths is None:
        return dict.fromkeys(scopes, True)
    for path in paths:
        if path.startswith("web/"):
            scopes["frontend"] = True
            if path.startswith("web/public/fleet-") and path.endswith(".json"):
                scopes["python"] = True  # Validate recorded traces against the simulator.
        elif path.startswith(("src/", "tests/", "scenarios/", "configs/")):
            scopes["python"] = True
            scopes["package"] |= path.startswith("src/")
            scopes["frontend"] |= path == "configs/benchmarks/main.json"
        elif path == "README.md" or path.startswith("docs/assets/"):
            scopes["frontend"] = True
            scopes["package"] |= path == "README.md"
        elif path == "LICENSE":
            scopes["package"] = True
        else:
            # Includes workflow/tooling changes and any new, unclassified inputs.
            return dict.fromkeys(scopes, True)
    return scopes


def changed_paths(event_name: str, event: dict) -> list[str] | None:
    if event_name == "push":
        base = event.get("before", "")
    elif event_name == "pull_request":
        base = event.get("pull_request", {}).get("base", {}).get("sha", "")
    else:
        return None
    if not re.fullmatch(r"[0-9a-f]{40}", base) or base == "0" * 40:
        return None
    try:
        subprocess.run(
            ["git", "fetch", "--no-tags", "--depth=1", "origin", base],
            check=True, capture_output=True,
        )
        result = subprocess.run(
            ["git", "diff", "--name-only", "--no-renames", "-z", base, "HEAD"],
            check=True, capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError):
        print("::warning::Cannot determine the complete diff; running all checks.")
        return None
    if not result.stdout:
        return []
    return result.stdout.decode("utf-8", errors="surrogateescape").rstrip("\0").split("\0")


if __name__ == "__main__":
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    scopes = classify(changed_paths(os.environ["GITHUB_EVENT_NAME"], event))
    print(json.dumps(scopes))
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        for name, enabled in scopes.items():
            print(f"{name}={str(enabled).lower()}", file=output)
