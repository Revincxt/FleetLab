"use client";

import { memo, useEffect, useRef, useState } from "react";
import type { MazeFrame, MazeScenario } from "./maze-model";
import type { WarehouseRenderer } from "./warehouse-renderer";
import type { WorkerTrafficFrame } from "./workforce-model";
import { Icon } from "./ui-icon";

function WarehouseScene({ scenario, frame, traffic, workerMoveSteps }: {
  scenario: MazeScenario;
  frame: MazeFrame;
  traffic: WorkerTrafficFrame[];
  workerMoveSteps: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<WarehouseRenderer | null>(null);
  const latestFrame = useRef(frame);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [attempt, setAttempt] = useState(0);
  const ready = status === "ready";
  const [zoom, setZoom] = useState(100);

  useEffect(() => {
    latestFrame.current = frame;
    runtime.current?.update(frame);
  }, [frame]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let cancelled = false;
    let renderer: WarehouseRenderer | null = null;
    const onUnavailable = () => {
      if (cancelled) return;
      runtime.current = null;
      renderer?.dispose();
      renderer = null;
      setStatus("unavailable");
    };
    // Keep Three.js and all browser-only renderer setup out of the initial bundle.
    import("./warehouse-renderer").then(({ WarehouseRenderer: Renderer }) => {
      if (cancelled) return;
      renderer = new Renderer(element, scenario, latestFrame.current, {
        onZoom: (value) => setZoom(Math.round(value * 100)),
        onUnavailable,
      }, traffic, workerMoveSteps);
      runtime.current = renderer;
      setZoom(100);
      setStatus("ready");
    }).catch(() => {
      if (!cancelled) onUnavailable();
    });
    return () => {
      cancelled = true;
      runtime.current = null;
      renderer?.dispose();
    };
  }, [scenario, traffic, workerMoveSteps, attempt]);

  return (
    <div className="warehouse-scene" data-scene-ready={ready} data-scene-status={status}>
      <div ref={host} className="scene-canvas" data-scene-interactive="true" />
      {status === "loading" ? <div className="scene-loading" role="status">Loading factory…</div> : null}
      {status === "unavailable" ? (
        <div className="scene-error" role="alert">
          <Icon name="top" />
          <strong>3D scene unavailable</strong>
          <p>Check WebGL and hardware acceleration in your browser.</p>
          <button onClick={() => { setStatus("loading"); setAttempt((value) => value + 1); }}>Retry</button>
        </div>
      ) : null}
      {ready ? <div className="scene-camera-tools">
        <div className="camera-controls" role="group" aria-label="3D camera controls">
          <button onClick={() => runtime.current?.topView()} aria-label="Top view" title="Top view">
            <Icon name="top" />
          </button>
          <button onClick={() => runtime.current?.reset()} aria-label="Reset camera" title="Reset 3D view (Home)">
            <Icon name="reset" />
          </button>
          <span className="camera-divider" aria-hidden="true" />
          <button disabled={zoom >= 275} onClick={() => runtime.current?.zoomBy(1.2)} aria-label="Zoom in" title="Zoom in (+)">
            <Icon name="plus" />
          </button>
          <output aria-label="Camera zoom">{zoom}%</output>
          <button disabled={zoom <= 65} onClick={() => runtime.current?.zoomBy(1 / 1.2)} aria-label="Zoom out" title="Zoom out (−)">
            <Icon name="minus" />
          </button>
        </div>
      </div> : null}
    </div>
  );
}

export default memo(WarehouseScene);
