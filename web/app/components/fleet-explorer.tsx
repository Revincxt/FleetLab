"use client";

import { useEffect, useState, type CSSProperties } from "react";
import WarehouseScene from "./warehouse-scene";
import TaskProgress from "./task-progress";
import { AlgorithmPicker } from "./algorithm-picker";
import { fleetAlgorithm, type FleetAlgorithmId } from "./fleet-algorithms";
import { Icon } from "./ui-icon";
import { BrandMark } from "./brand-mark";
import { ForkliftGlyph } from "./forklift-glyph";
import { chargingStationState, displayedOrderState, isVehicleLoaded, parseFleetGallery, releasedOrderEntries, vehiclePoint, type FleetGallery } from "./fleet-model";
import { batteryColors, batteryToneHints, eventLabels, fleetStatusTone, gridCellHint, orderLabels, simulationStepHint, statusColors, statusToneHints, vehicleBatteryTone, vehicleStatusHint, vehicleStatusLabel, vehicleStatusTone } from "./fleet-terminology";
import type { MazeFrame } from "./maze-model";

const speeds = [0.5, 1, 2] as const;

export default function FleetExplorer() {
  const [gallery, setGallery] = useState<FleetGallery | null>(null);
  const [caseId, setCaseId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [algorithmId, setAlgorithmId] = useState<FleetAlgorithmId>("coordinated-astar");
  const [algorithmRequest, setAlgorithmRequest] = useState<FleetAlgorithmId | null>(null);
  const [loadingAlgorithm, setLoadingAlgorithm] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof speeds)[number]>(1);
  const [taskFilter, setTaskFilter] = useState<"all" | "open" | "done">("open");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [fleetCollapsed, setFleetCollapsed] = useState(false);
  const [tasksCollapsed, setTasksCollapsed] = useState(false);
  const replay = gallery?.cases.find((item) => item.caseId === caseId) ?? gallery?.cases[0] ?? null;
  const maximumTime = replay ? replay.frames.length - 1 : 0;
  const stepDuration = Math.round(260 / speed);

  useEffect(() => {
    const controller = new AbortController();
    const algorithm = fleetAlgorithm(algorithmRequest ?? new URLSearchParams(window.location.search).get("algorithm"));
    fetch(algorithm.file, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Fleet replay returned ${response.status}.`);
        return response.json() as Promise<unknown>;
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        const payload = parseFleetGallery(data, algorithm.label);
        const requestedCase = new URLSearchParams(window.location.search).get("case");
        const initialCase = payload.cases.find((item) => item.caseId === requestedCase)
          ?? payload.cases.find((item) => item.caseId === payload.defaultCaseId) ?? payload.cases[0];
        setGallery(payload);
        setAlgorithmId(algorithm.id);
        setLoadingAlgorithm(false);
        setError(null);
        setPlaying(false);
        setTime(0);
        setSelectedOrderId(null);
        setCaseId(initialCase.caseId);
        setSelectedId(initialCase.vehicles[0].id);
        const url = new URL(window.location.href);
        url.searchParams.set("algorithm", algorithm.id);
        window.history.replaceState(null, "", url);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setLoadingAlgorithm(false);
          setError(reason instanceof Error ? reason.message : "Could not load the fleet replay.");
        }
      });
    return () => controller.abort();
  }, [attempt, algorithmRequest]);

  useEffect(() => {
    if (!playing || !maximumTime) return;
    const timer = window.setInterval(() => {
      setTime((current) => {
        if (current + 1 >= maximumTime) setPlaying(false);
        return Math.min(maximumTime, current + 1);
      });
    }, stepDuration);
    return () => window.clearInterval(timer);
  }, [playing, maximumTime, stepDuration]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!replay || loadingAlgorithm || event.altKey || event.ctrlKey || event.metaKey ||
        (event.target as HTMLElement | null)?.closest("input, select, button, a, textarea, [contenteditable='true'], [data-scene-interactive], [data-task-scroll], [data-fleet-scroll]")) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (event.repeat) return;
        if (time >= maximumTime) setTime(0);
        setPlaying((value) => !value);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        setPlaying(false);
        setTime((current) => Math.max(0, Math.min(maximumTime, current + (event.key === "ArrowRight" ? 1 : -1))));
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [replay, maximumTime, time, loadingAlgorithm]);

  if (error && !gallery) return (
    <main className="loading-shell error-shell" role="alert">
      <BrandMark /><h1>Fleet replay unavailable</h1><p>{error}</p>
      <button onClick={() => { setError(null); setAttempt((value) => value + 1); }}>Reload</button>
    </main>
  );
  if (!gallery || !replay) return (
    <main className="loading-shell" aria-live="polite">
      <BrandMark /><span className="loading-mark">FleetLab</span><p>Loading fleet replay…</p>
    </main>
  );

  const pad = (value: number | string, length = 2) => String(value).padStart(length, "0");
  const { scenario } = replay;
  const palette = ["#c9ee96", "#e7b981", "#b8aff0", "#79cdd3"];
  const vehicles = replay.vehicles.map((vehicle, index) => ({ ...vehicle, color: palette[index] ?? vehicle.color }));
  const layoutNames: Record<string, string> = {
    "rack-maze": "Central Aisle",
    "parallel-aisles": "Long Aisles",
    "cross-dock": "Mixed Layout",
    serpentine: "Offset Aisles",
  };
  const frame = replay.frames[time];
  const selectedIndex = Math.max(0, vehicles.findIndex((vehicle) => vehicle.id === selectedId));
  const selected = vehicles[selectedIndex];
  const current = frame.vehicles[selectedIndex];
  const complete = time === maximumTime;
  const orderStates = scenario.orders.map((order) => displayedOrderState(frame.orderStates[order.id]));
  const releasedOrders = releasedOrderEntries(scenario.orders, frame);
  const releasedCount = releasedOrders.length;
  const visibleSelectedOrderId = releasedOrders.some(({ order }) => order.id === selectedOrderId) ? selectedOrderId : null;
  const fleetTone = fleetStatusTone(frame.vehicles);
  const filteredOrders = releasedOrders.filter(({ index }) =>
    taskFilter === "all" || (taskFilter === "done" ? orderStates[index] === "delivered" : !["delivered", "expired"].includes(orderStates[index]))
  );
  if (taskFilter === "open") {
    const rank = (index: number) => orderStates[index] === "carried" ? 0
      : frame.vehicles.some((vehicle) => vehicle.assignedOrderId === scenario.orders[index].id) ? 1
      : orderStates[index] === "ready" ? 2 : 3;
    filteredOrders.sort((a, b) => rank(a.index) - rank(b.index) || a.order.releaseTime - b.order.releaseTime || a.index - b.index);
  }
  const openCount = releasedOrders.filter(({ index }) => !["delivered", "expired"].includes(orderStates[index])).length;
  const fleet = vehicles.map((vehicle, index) => ({
    id: vehicle.id, label: vehicle.badge, color: vehicle.color,
    position: vehiclePoint(frame.vehicles[index]), complete,
    carrying: isVehicleLoaded(frame.vehicles[index]),
  }));
  const sceneFrame: MazeFrame = {
    time, animate: playing, stepDuration, fleet, highlightedOrderId: visibleSelectedOrderId,
    primary: fleet[selectedIndex],
    primaryRoute: replay.frames.slice(0, time + 1).map((item) => vehiclePoint(item.vehicles[selectedIndex])),
    blocked: frame.blocked, orderStates,
    orderColors: scenario.orders.map((order) => {
      const carrier = frame.vehicles.findIndex((vehicle) => vehicle.carriedOrderId === order.id);
      return carrier >= 0 ? vehicles[carrier].color : null;
    }),
    description: `${vehicles.length} forklifts at simulation step ${time}. ${frame.completedOrders} of ${releasedCount} released tasks delivered. AGV ${selected.badge} at grid cell (${current.position.join(", ")}). ${gridCellHint}`,
  };
  const seek = (value: number) => { setPlaying(false); setTime(Math.max(0, Math.min(maximumTime, value))); };
  const choose = (id: string) => { setSelectedId(id); setSelectedOrderId(null); };
  const chooseAlgorithm = (id: FleetAlgorithmId) => {
    setPlaying(false); setError(null); setLoadingAlgorithm(true);
    setAlgorithmRequest(id); setAttempt((value) => value + 1);
  };
  const algorithmControl = <AlgorithmPicker value={algorithmId} loading={loadingAlgorithm} onChange={chooseAlgorithm} />;
  const chooseLayout = (id: string) => {
    if (!gallery.cases.some((item) => item.caseId === id)) return;
    setPlaying(false); setTime(0); setCaseId(id); setSelectedOrderId(null);
    const url = new URL(window.location.href);
    url.searchParams.set("case", id);
    window.history.replaceState(null, "", url);
  };
  const inspectTask = (id: string) => {
    setSelectedOrderId((previous) => previous === id ? null : id);
    const assigned = frame.vehicles.find((vehicle) => vehicle.carriedOrderId === id || vehicle.assignedOrderId === id);
    if (assigned) setSelectedId(assigned.id);
  };

  return (
    <main className="app-shell control-room">
      <header className="app-header">
        <a className="brand" href="#workspace" aria-label="FleetLab home">
          <span className="brand-mark"><BrandMark /></span>
          <span className="brand-name">FleetLab</span>
        </a>
        <div className="header-actions">
          <label className="layout-picker"><span className="sr-only">Factory layout</span><Icon name="grid" />
            <select value={replay.caseId} disabled={loadingAlgorithm} onChange={(event) => chooseLayout(event.target.value)}>
              {gallery.cases.map((item) => <option value={item.caseId} key={item.caseId}>{layoutNames[item.caseId] ?? item.label}</option>)}
            </select>
            <Icon name="arrow" className="picker-chevron" />
          </label>
          <a href="https://github.com/Revincxt/adaptive-agent" aria-label="View repository on GitHub" title="View project on GitHub"><Icon name="code" /></a>
        </div>
      </header>
      {error ? <div className="algorithm-error" role="alert"><span>{error}</span><button onClick={() => chooseAlgorithm(algorithmRequest ?? algorithmId)}>Retry</button><button onClick={() => setError(null)} aria-label="Dismiss replay error">×</button></div> : null}

      <div className="control-workspace" id="workspace">
        <div className="fleet-sidebar">
          <TaskProgress replay={replay} time={time} />
        <aside className={"fleet-panel side-panel " + (fleetCollapsed ? "is-collapsed" : "")} aria-label="Fleet status" data-state={fleetTone} style={{ "--status-color": statusColors[fleetTone] } as CSSProperties}>
          <header className="side-heading"><h2 title={"Fleet: " + statusToneHints[fleetTone]}><Icon name="robot" />Fleet</h2>
            <button className="collapse-button" onClick={() => setFleetCollapsed((value) => !value)} aria-expanded={!fleetCollapsed} aria-label={fleetCollapsed ? "Expand fleet panel" : "Collapse fleet panel"} title={fleetCollapsed ? "Expand fleet panel" : "Collapse fleet panel"}><Icon name="arrow" /></button>
          </header>
          <div className="fleet-cards" role="group" aria-label="Inspect forklift" tabIndex={0} data-fleet-scroll hidden={fleetCollapsed}>
            {vehicles.map((vehicle, index) => {
              const robot = frame.vehicles[index];
              const level = Math.round(robot.battery / scenario.batteryCapacity * 100);
              const stateTone = vehicleStatusTone(robot);
              const batteryTone = vehicleBatteryTone(robot, scenario.batteryCapacity);
              const task = scenario.orders.findIndex((order) => order.id === (robot.carriedOrderId ?? robot.assignedOrderId));
              return <button key={vehicle.id} className={"vehicle-card " + (selected.id === vehicle.id ? "is-active" : "")} data-state={stateTone} data-battery={batteryTone} style={{ "--vehicle-color": vehicle.color, "--status-color": statusColors[stateTone], "--battery-color": batteryColors[batteryTone] } as CSSProperties} onClick={() => choose(vehicle.id)} aria-label={"Inspect " + vehicle.label} aria-pressed={selected.id === vehicle.id}>
                <span className="vehicle-card-heading"><span className="vehicle-symbol"><ForkliftGlyph loaded={isVehicleLoaded(robot)} /></span><strong><span>AGV</span> {vehicle.badge}</strong><span className="vehicle-status" title={robot.violations.length ? "Constraint violation: " + robot.violations.join(", ") : vehicleStatusHint(robot)}><i />{vehicleStatusLabel(robot)}</span></span>
                <span className="vehicle-details"><span>Task <b>{task >= 0 ? "#" + pad(task + 1, 3) : "—"}</b></span><span>Delivered <b>{robot.deliveredOrders}</b></span></span>
                <span className="vehicle-battery-label" title={batteryToneHints[batteryTone]}><span><Icon name="bolt" />Battery</span><strong>{level}<small>%</small></strong></span>
                <span className="vehicle-battery-track"><i style={{ width: level + "%" }} /></span>
                <span className="vehicle-position" title={gridCellHint}>Grid cell <span>({robot.position.join(", ")})</span><Icon name="arrow" /></span>
              </button>;
            })}
          </div>
        </aside>
        </div>

        <section className="map-panel" aria-label="Recorded simulation replay" aria-busy={loadingAlgorithm}>
          <header className="map-heading">
            <div>{algorithmControl}<span className={"playback-status " + (playing ? "is-playing" : "")} aria-live="polite" title="Recorded simulation, not live robot telemetry"><i />{loadingAlgorithm ? "Loading…" : playing ? "Playing" : complete ? "Finished" : "Paused"}</span></div>
          </header>
          <div className="map-stage is-3d">
            {frame.blocked.length ? <span className="closure-status" role="status" aria-label={frame.blocked.length + " blocked cells"}>{frame.blocked.length} blocked cells</span> : null}
            {visibleSelectedOrderId ? <button className="task-focus-chip" onClick={() => setSelectedOrderId(null)} aria-label="Clear task selection">Task #{pad(scenario.orders.findIndex((order) => order.id === visibleSelectedOrderId) + 1, 3)}<span>×</span></button> : null}
            <WarehouseScene key={replay.caseId + "-" + algorithmId} scenario={scenario} frame={sceneFrame} />
          </div>
          <div className="replay-controls">
            <div className="timeline-control">
              <input type="range" min="0" max={maximumTime} value={time} aria-label={"Replay step, " + time + " of " + maximumTime} aria-valuetext={`Step ${time} of ${maximumTime}`} title={simulationStepHint} style={{ "--timeline-progress": time / maximumTime * 100 + "%" } as CSSProperties} onChange={(event) => seek(Number(event.target.value))} />
              <div className="timeline-events" role="group" aria-label="Scenario event shortcuts">
                {scenario.events.filter((event) => event.time <= maximumTime && (event.kind !== "order_arrival" || event.time <= time)).map((event, index) => <button key={event.time + "-" + index} className={"timeline-event event-" + event.kind} style={{ left: event.time / maximumTime * 100 + "%", "--event-lane": index % 2 } as CSSProperties} onClick={() => seek(event.time)} aria-label={eventLabels[event.kind] + " · Step " + event.time} title={eventLabels[event.kind] + " · Step " + event.time} />)}
              </div>
            </div>
            <div className="transport-row">
              <div className="transport-controls" role="group" aria-label="Replay transport">
                <button onClick={() => seek(0)} disabled={!time && !playing} aria-label="Restart replay" title="Restart replay"><Icon name="restart" /></button>
                <button onClick={() => seek(time - 1)} disabled={!time} aria-label="Previous time step" title="Previous step (←)"><Icon name="back" /></button>
                <button className="play-button" disabled={loadingAlgorithm} onClick={() => { if (complete) setTime(0); setPlaying((value) => !value); }} aria-label={playing ? "Pause replay" : complete ? "Replay from start" : "Play replay"} aria-keyshortcuts="Space" title="Play / pause (Space)"><Icon name={playing ? "pause" : "play"} /></button>
                <button onClick={() => seek(time + 1)} disabled={complete} aria-label="Next time step" title="Next step (→)"><Icon name="next" /></button>
              </div>
              <div className="speed-control" role="group" aria-label="Playback speed">{speeds.map((rate) => <button key={rate} className={speed === rate ? "is-active" : ""} aria-pressed={speed === rate} onClick={() => setSpeed(rate)}>{rate}×</button>)}</div>
            </div>
          </div>
        </section>

        <div className="operations-panel">
          <section className="chargers-panel side-panel" aria-labelledby="chargers-title">
            <header className="side-heading"><h2 id="chargers-title"><Icon name="bolt" />Chargers</h2></header>
            <ul className="charger-list" aria-label="Charging station status">
              {scenario.chargingStations.map((station, index) => {
                const { vehicle: robot, status } = chargingStationState(station, frame);
                const vehicle = vehicles.find((item) => item.id === robot?.id);
                const label = status === "charging" ? "Charging" : status === "occupied" ? "Occupied" : "Unoccupied";
                return <li key={index} className={"charger-card is-" + status} data-charger={index + 1} data-status={status} style={{ "--vehicle-color": vehicle?.color } as CSSProperties} aria-label={"Charger " + (index + 1) + ": " + label} title={"Grid cell (" + station.x + ", " + station.y + "). " + (status === "charging" ? "Charging action recorded at this step." : status === "occupied" ? "A vehicle is present, but is not charging at this step." : "No vehicle is present at this step; reservations are not recorded.")}>
                  <div className="charger-card-heading"><strong><span className="charger-symbol"><Icon name="charger" /></span>{pad(index + 1)}</strong>{robot ? <span className="charger-battery" title="Vehicle battery level">{Math.round(robot.battery / scenario.batteryCapacity * 100)}<small>%</small></span> : null}</div>
                  <span className="charger-state"><i />{label}</span>
                  {vehicle ? <button className="charger-vehicle" onClick={() => choose(vehicle.id)} aria-label={"Inspect AGV " + vehicle.badge + " at charger " + (index + 1)}><span><i />AGV {vehicle.badge}</span><Icon name="arrow" /></button> : <span className="charger-location">Grid ({station.x}, {station.y})</span>}
                </li>;
              })}
            </ul>
          </section>
          <aside className={"tasks-panel side-panel " + (tasksCollapsed ? "is-collapsed" : "")} aria-label="Task queue">
            <header className="side-heading"><h2><Icon name="box" />Tasks <small title="Released tasks">{releasedCount}</small></h2><button className="collapse-button" onClick={() => setTasksCollapsed((value) => !value)} aria-expanded={!tasksCollapsed} aria-label={tasksCollapsed ? "Expand task panel" : "Collapse task panel"} title={tasksCollapsed ? "Expand task panel" : "Collapse task panel"}><Icon name="arrow" /></button></header>
            <div className="task-panel-content" hidden={tasksCollapsed}>
              <nav className="task-filters" aria-label="Task filters">{(["all", "open", "done"] as const).map((filter) => <button key={filter} className={taskFilter === filter ? "is-active" : ""} aria-pressed={taskFilter === filter} onClick={() => setTaskFilter(filter)} data-filter={filter}>{filter === "all" ? "All" : filter === "open" ? "Open" : "Delivered"}<span>{filter === "all" ? releasedCount : filter === "open" ? openCount : frame.completedOrders}</span></button>)}</nav>
              <ol key={replay.caseId + "-" + taskFilter} className="task-list" aria-label="Task list" tabIndex={0} data-task-scroll>
                {filteredOrders.map(({ order, index }) => {
                  const state = orderStates[index];
                  const owner = frame.vehicles.findIndex((vehicle) => vehicle.carriedOrderId === order.id || vehicle.assignedOrderId === order.id);
                  return <li key={order.id} className={"task-row is-" + state}><button className={"task-card " + (selectedOrderId === order.id ? "is-selected" : "")} aria-pressed={selectedOrderId === order.id} aria-label={"Locate task " + (index + 1)} onClick={() => inspectTask(order.id)}>
                    <span className="task-card-heading"><strong><span>#</span><span className="order-number">{pad(index + 1, 3)}</span></strong><span className={"task-status is-" + state}><i />{orderLabels[state]}</span></span>
                    <span className="task-route"><span title="Pickup grid cell (x, y)"><i>P</i>({order.pickup.x}, {order.pickup.y})</span><span className="route-connector"><Icon name="arrow" /></span><span title="Delivery grid cell (x, y)"><i>D</i>({order.dropoff.x}, {order.dropoff.y})</span></span>
                    <span className="task-card-meta"><span className="task-owner" style={{ "--owner-color": owner >= 0 ? vehicles[owner].color : undefined } as CSSProperties}>{owner >= 0 ? <><i aria-hidden="true" />{"AGV " + vehicles[owner].badge}</> : state === "ready" ? "Unassigned" : null}</span><span>Priority {order.priority}</span></span>
                  </button></li>;
                })}
                {!filteredOrders.length ? <li className="empty-tasks"><Icon name="check" /><strong>{taskFilter === "done" ? "No delivered tasks" : releasedCount < scenario.orders.length ? "Waiting for tasks" : "No open tasks"}</strong></li> : null}
              </ol>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
