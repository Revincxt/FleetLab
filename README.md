<div align="center">

# FleetLab

Multi-AGV warehouse simulation and interactive 3D replay.

[![CI](https://github.com/Revincxt/FleetLab/actions/workflows/ci.yml/badge.svg)](https://github.com/Revincxt/FleetLab/actions/workflows/ci.yml)
[![Node.js 22.13+](https://img.shields.io/badge/Node.js-22.13%2B-417E38.svg)](web/package.json)
[![MIT License](https://img.shields.io/badge/License-MIT-5955CA.svg)](LICENSE)

**[Live demo](https://revincxt.github.io/FleetLab/)** · [Quick start](#quick-start)

</div>

[![FleetLab showing a 3D factory, forklifts, chargers, and a shared task queue](docs/assets/replay-explorer.png)](https://revincxt.github.io/FleetLab/)

## Overview

FleetLab brings warehouse fleet operations into an interactive 3D workspace.
Python simulates the fleet; the web app visualizes recorded runs.

- **Fleet operations** — Shared tasks, coordinated routes, automatic charging, and vehicle status.
- **Factory view** — Switch layouts and inspect forklift cargo, task locations, and vehicle trails.
- **Replay** — Follow progressive task releases with playback, timeline, and task-filter controls.

## Routing algorithms

| Algorithm | Approach |
| --- | --- |
| Coordinated A* | Occupancy-aware A* with per-step cell and edge reservations. |
| WHCA* | Windowed space-time planning with rotating vehicle priority. |
| RHCR + PBS | Rolling-horizon planning with conflict-driven priority search. |

All three share task allocation, charging rules, and seeded scenarios.
The selector switches between their recorded runs.

## Quick start

Requires **Node.js 22.13+**, **pnpm 11**, and a WebGL-capable browser.

From the repository root:

```bash
cd web
pnpm install --frozen-lockfile
pnpm dev
```

Open the local URL printed by the dev server. Replay data is included;
no Python process is needed to use the viewer.

<details>
<summary>Generate new replays with Python</summary>

From the repository root, with **Python 3.11+**:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -e .

python -m adaptive_agent_lab.reporting.fleet \
  --config configs/fleet-demo.json --algorithm coordinated-astar \
  --output web/public/fleet-demo.json

python -m adaptive_agent_lab.reporting.fleet \
  --config configs/fleet-demo.json --algorithm whca \
  --output web/public/fleet-whca.json

python -m adaptive_agent_lab.reporting.fleet \
  --config configs/fleet-demo.json --algorithm rhcr-pbs \
  --output web/public/fleet-rhcr-pbs.json
```

Set task count, random seed, and simulation horizon in
[`configs/fleet-demo.json`](configs/fleet-demo.json).
Regenerate all three files with the same configuration to keep the runs comparable.

</details>

## Development

From `web/`:

```bash
pnpm lint
pnpm test:scene
pnpm test:pages
```

The checks cover scene behavior, recorded fleet data, and the static GitHub Pages build.
`pnpm build:pages` creates `web/dist/pages/` without publishing it.
