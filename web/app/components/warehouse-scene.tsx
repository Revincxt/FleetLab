"use client";

import { useEffect, useRef, useState } from "react";
import type { MazeFrame, MazeScenario } from "./maze-model";
import type { WarehouseRenderer } from "./warehouse-renderer";

const cameraIcons = {
  top: "M12 3v8m-3-3 3 3 3-3M3 17l9-4 9 4-9 4-9-4Z",
  reset: "m12 3 8 5v8l-8 5-8-5V8l8-5ZM4 8l8 5 8-5M12 13v8",
  minus: "M5 12h14",
  plus: "M5 12h14M12 5v14",
};

function CameraIcon({ name }: { name: keyof typeof cameraIcons }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={cameraIcons[name]} />
    </svg>
  );
}

export default function WarehouseScene({ scenario, frame }: {
  scenario: MazeScenario;
  frame: MazeFrame;
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
      });
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
  }, [scenario, attempt]);

  return (
    <div className="warehouse-scene" data-scene-ready={ready} data-scene-status={status}>
      <div ref={host} className="scene-canvas" data-scene-interactive="true" />
      {status === "loading" ? <div className="scene-loading" role="status">Loading factory…</div> : null}
      {status === "unavailable" ? (
        <div className="scene-error" role="alert">
          <CameraIcon name="top" />
          <strong>3D scene unavailable</strong>
          <p>Check WebGL and hardware acceleration in your browser.</p>
          <button onClick={() => { setStatus("loading"); setAttempt((value) => value + 1); }}>Retry</button>
        </div>
      ) : null}
      {ready ? <div className="scene-camera-tools">
        <div className="camera-controls" role="group" aria-label="3D camera controls">
          <button disabled={!ready} onClick={() => runtime.current?.topView()} aria-label="Top view" title="Top view">
            <CameraIcon name="top" />
          </button>
          <button disabled={!ready} onClick={() => runtime.current?.reset()} aria-label="Reset camera" title="Reset 3D view (Home)">
            <CameraIcon name="reset" />
          </button>
          <span className="camera-divider" aria-hidden="true" />
          <button disabled={!ready || zoom >= 275} onClick={() => runtime.current?.zoomBy(1.2)} aria-label="Zoom in" title="Zoom in (+)">
            <CameraIcon name="plus" />
          </button>
          <output aria-label="Camera zoom">{zoom}%</output>
          <button disabled={!ready || zoom <= 65} onClick={() => runtime.current?.zoomBy(1 / 1.2)} aria-label="Zoom out" title="Zoom out (−)">
            <CameraIcon name="minus" />
          </button>
        </div>
      </div> : null}
    </div>
  );
}
