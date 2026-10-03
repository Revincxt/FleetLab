<div align="center">

# Adaptive Agent Lab

Planning, reinforcement learning, and hybrid control in a dynamic warehouse.

[![CI](https://github.com/Revincxt/adaptive-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Revincxt/adaptive-agent/actions/workflows/ci.yml)
[![Python 3.11+](https://img.shields.io/badge/Python-3.11%2B-3776AB.svg)](https://www.python.org/)
[![MIT License](https://img.shields.io/badge/License-MIT-5955CA.svg)](LICENSE)

**[Live demo](https://revincxt.github.io/adaptive-agent/)** · [Quick start](#quick-start) · [Documentation](#documentation)

</div>

[![Replay explorer showing a warehouse route, robot state, and playback controls](docs/assets/replay-explorer.png)](https://revincxt.github.io/adaptive-agent/)

<p align="center">4 layouts · 6 controllers · Seeded, reproducible replays</p>

## Controllers

- **Planning** — Open-loop A* and event-triggered A* replanning.
- **Learning** — Tabular Q-learning, Dyna-Q, and goal-guided NumPy DQN.
- **Hybrid** — Learned high-level options with A* routing.

One shared simulator, action space, and seeded scenarios. Scrub through events,
compare trajectories, and inspect orders, battery, and returns in the demo.

> **Alpha · Demo only.** Replays are not held-out benchmarks or algorithm rankings.
> The benchmark command uses fresh agents; learner runs are untrained smoke tests.
> See the [experiment protocol](docs/experiment-protocol.md) for evaluation limits.

## Quick start

From the repository root, with **Python 3.11+**:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[dev]'

aal run --agent replanning \
  --scenario scenarios/small/dynamic-demo.json --seed 42
```

Use `aal --help` for training, scenario generation, and benchmarks.

For the replay UI, with **Node.js 22.13+** and **pnpm**:

```bash
cd web
pnpm install
pnpm dev
```

## Documentation

[Problem formulation](docs/problem-formulation.md) ·
[Architecture](docs/architecture.md) ·
[Experiment protocol](docs/experiment-protocol.md) ·
[Demo development](web/README.md) ·
[Contributing](CONTRIBUTING.md)

Single-robot, fully observable simulation. Licensed under [MIT](LICENSE).
