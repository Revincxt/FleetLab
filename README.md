<div align="center">

# FleetLab

Coordinated forklifts. Shared factory floors. Interactive 3D simulation replays.

[![CI](https://github.com/Revincxt/FleetLab/actions/workflows/ci.yml/badge.svg)](https://github.com/Revincxt/FleetLab/actions/workflows/ci.yml)
[![Node.js 22.13+](https://img.shields.io/badge/Node.js-22.13%2B-417E38.svg)](web/package.json)
[![MIT License](https://img.shields.io/badge/License-MIT-5955CA.svg)](LICENSE)

**[Live demo](https://revincxt.github.io/FleetLab/)** · [Quick start](#quick-start)

</div>

[![FleetLab industrial factory with task-scoped routes, fleet and charger status, and a compact task queue](docs/assets/replay-explorer.png)](https://revincxt.github.io/FleetLab/)

## Overview

FleetLab simulates warehouse fleets sharing tasks, navigating traffic, and recharging.
A Python simulator generates reproducible runs; the 3D web viewer lets you explore them.

- **Factory floor** — Four layouts with working forklifts, visible cargo, and three patrolling workers that planners avoid.
- **Task routes** — Inspect the selected forklift's current task: solid lines show travel so far, dashed lines show its recorded plan. Finished task markers disappear.
- **Operations** — Seeded tasks arrive progressively. Track the fleet, charging stations, and task queue with playback and timeline controls.

## Routing algorithms

| Algorithm | Approach |
| --- | --- |
| Coordinated A* | Occupancy-aware A* with per-step cell and edge reservations. |
| WHCA* | Windowed space-time planning with rotating vehicle priority. |
| RHCR + PBS | Rolling-horizon planning with conflict-driven priority search. |

Switch between recorded runs using the algorithm selector. All three use the same task
allocation and charging rules; windowed planners display their current planning horizon.

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

## Reference

1. David Silver. [Cooperative Pathfinding](https://ojs.aaai.org/index.php/AIIDE/article/view/18726). AIIDE, 2005. — WHCA*.
2. Hang Ma et al. [Searching with Consistent Prioritization for Multi-Agent Path Finding](https://ojs.aaai.org/index.php/AAAI/article/view/4758). AAAI, 2019. — Priority-Based Search (PBS).
3. Jiaoyang Li et al. [Lifelong Multi-Agent Path Finding in Large-Scale Warehouses](https://ojs.aaai.org/index.php/AAAI/article/view/17344). AAAI, 2021. — Rolling-Horizon Collision Resolution (RHCR).
