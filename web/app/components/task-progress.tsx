"use client";

import { useId, useMemo } from "react";
import type { FleetReplay } from "./fleet-model";
import { chartCeiling, taskAreaPath, taskHistory, taskStepPath } from "./task-progress-model";

export default function TaskProgress({ replay, time }: { replay: FleetReplay; time: number }) {
  const chartId = useId();
  const history = useMemo(() => taskHistory(replay, time), [replay, time]);
  const latest = history[history.length - 1];
  const maximum = chartCeiling(latest.released);
  const xTicks = [...new Set([0, Math.round(time / 2), time])];

  return <section className="task-progress-panel side-panel" aria-labelledby={`${chartId}-heading`}>
    <header className="chart-heading"><h2 id={`${chartId}-heading`}>Task progress</h2><span title="Delivered / released tasks" aria-label="Delivered / released tasks">{latest.released ? Math.round(latest.delivered / latest.released * 100) : 0}%</span></header>
    <div className="chart-legend" aria-label="Task totals at selected step">
      <span className="series-released"><i />Released<strong>{latest.released}</strong></span>
      <span className="series-delivered"><i />Delivered<strong>{latest.delivered}</strong></span>
    </div>
    <div className="task-history-chart">
      <div className="chart-y-axis" aria-hidden="true">{[4, 2, 0].map((tick) => <span key={tick} style={{ top: `${100 - tick * 25}%` }}>{maximum * tick / 4}</span>)}</div>
      <svg className="task-history-plot" viewBox="0 0 1000 240" preserveAspectRatio="none" role="img" aria-labelledby={`${chartId}-title ${chartId}-description`}>
        <title id={`${chartId}-title`}>Released and delivered tasks through step {time}</title>
        <desc id={`${chartId}-description`}>{latest.released} released, {latest.delivered} delivered. Counts change at recorded simulation steps. Future tasks are not shown.</desc>
        <defs>
          <linearGradient id={`${chartId}-released-fill`} className="series-released" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="240">
            <stop offset="0%" stopColor="var(--series-color)" stopOpacity="0.24" />
            <stop offset="100%" stopColor="var(--series-color)" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id={`${chartId}-delivered-fill`} className="series-delivered" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="240">
            <stop offset="0%" stopColor="var(--series-color)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--series-color)" stopOpacity="0.04" />
          </linearGradient>
        </defs>
        <path className="task-area series-released" d={taskAreaPath(history, "released", maximum)} fill={`url(#${chartId}-released-fill)`} />
        <path className="task-area series-delivered" d={taskAreaPath(history, "delivered", maximum)} fill={`url(#${chartId}-delivered-fill)`} />
        {[0, 120].map((y) => <line key={y} x1="0" x2="1000" y1={y} y2={y} className="chart-gridline" vectorEffect="non-scaling-stroke" />)}
        <path className="chart-axis-line" d="M0,0V240H1000" vectorEffect="non-scaling-stroke" />
        <path className="task-series series-released" d={taskStepPath(history, "released", maximum)} vectorEffect="non-scaling-stroke"><title>Released: {latest.released}</title></path>
        <path className="task-series series-delivered" d={taskStepPath(history, "delivered", maximum)} vectorEffect="non-scaling-stroke"><title>Delivered: {latest.delivered}</title></path>
        {time > 0 ? <path className="chart-endpoint series-delivered" d={`M1000,${240 - latest.delivered / maximum * 240}h0.01`} vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      <div className="chart-x-axis" aria-hidden="true">{xTicks.map((step) => <span className="chart-x-tick" key={step} style={{ left: `${step / Math.max(time, 1) * 100}%` }}>{step}</span>)}<span className="chart-axis-unit">Step</span></div>
    </div>
  </section>;
}
