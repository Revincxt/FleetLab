import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

function isCompactJson(text) {
  let quoted = false;
  const length = text.endsWith("\n") ? text.length - 1 : text.length;
  for (let index = 0; index < length; index++) {
    const code = text.charCodeAt(index);
    if (quoted && code === 92) { index++; continue; }
    if (code === 34) quoted = !quoted;
    else if (!quoted && (code === 32 || code === 9 || code === 10 || code === 13)) return false;
  }
  return !quoted;
}

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the production fleet shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(
    html,
    /<title>FleetLab — Fleet Simulation<\/title>/i,
  );
  assert.match(html, /Loading fleet replay/);
  assert.match(html, /FleetLab/);
  assert.doesNotMatch(html, /Adaptive Agent Lab/);
  assert.match(html, /lang="en"/);
  assert.doesNotMatch(html, /\p{Script=Han}/u);
  assert.match(html, /name="theme-color" content="#0d1115"/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
});

test("ships all four maps with four shared-world vehicles and no single-car UI", async () => {
  const [artifactText, page, css] = await Promise.all([
    readFile(new URL("../public/fleet-demo.json", import.meta.url), "utf8"),
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const artifact = JSON.parse(artifactText);
  assert.ok(isCompactJson(artifactText), "The shipped replay has no whitespace outside JSON strings");
  assert.equal(artifact.kind, "fleet-gallery");
  assert.equal(artifact.schemaVersion, 2);
  assert.equal(artifact.defaultCaseId, "rack-maze");
  assert.deepEqual(artifact.cases.map(item => item.caseId), ["rack-maze", "parallel-aisles", "cross-dock", "serpentine"]);
  const fingerprints = new Set();
  for (const item of artifact.cases) {
    assert.equal(item.kind, "fleet-replay");
    assert.equal(item.vehicles.length, 4);
    assert.equal(item.verificationStatus, "DEMO · NON-CONFIRMATORY · SHARED FLEET");
    assert.match(item.scenarioFingerprint, /^sha256:[0-9a-f]{64}$/);
    fingerprints.add(item.scenarioFingerprint);
    assert.equal(item.scenario.width, 32);
    assert.equal(item.scenario.height, 24);
    assert.equal(item.scenario.orders.length, 225);
    assert.equal(item.scenario.horizon, 7200);
    assert.equal(item.scenario.orders.flatMap(order => [order.pickup, order.dropoff]).length, 450);
    assert.equal(item.scenario.chargingStations.length, 4);
    assert.equal(item.scenario.events.filter(event => event.kind === "cell_blocked").length, 6);
    assert.equal(item.summary.completedOrders, 225);
    assert.equal(item.summary.constraintViolations, 0);
    assert.ok(item.frames.every(frame => frame.vehicles.length === 4));
    assert.ok(item.frames.at(-1).vehicles.every(vehicle => vehicle.deliveredOrders > 0));
  }
  assert.equal(fingerprints.size, 4);
  for (const text of ["fetch(algorithm.file", "Factory layout", "chooseLayout", "Inspect forklift", "Task list", "type=\"range\"", "new URLSearchParams", "url.searchParams.set(\"case\""]) assert.ok(page.includes(text), text);
  assert.doesNotMatch(page, /Scenario library|scenario-option|Compare with|demo-data.json|map-mode-switch/);
  for (const text of ["Fleet status", "Task queue", "algorithmControl", "task-filters", "Collapse fleet panel", "Collapse task panel", "inspectTask", "highlightedOrderId", "Recorded simulation replay"]) assert.ok(page.includes(text), text);
  assert.match(css, /\.control-workspace/);
  assert.match(css, /color-scheme: dark/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test("keeps operational information without decorative or repeated copy", async () => {
  const [page, scene, renderer] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/warehouse-scene.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/warehouse-renderer.ts", import.meta.url), "utf8"),
  ]);
  for (const copy of ["FLEET CONTROL", "01 / FLOOR", "RUN SUMMARY", "Simulation data", "Play the replay to see progress", "All tasks processed", "No more events", "system-footer", "mode-badge"]) {
    assert.ok(!page.includes(copy), copy);
  }
  assert.ok(!scene.includes("scene-hint"), "Camera help is available on hover, not permanently over the map");
  assert.ok(renderer.includes('title = "Drag to orbit · Scroll to zoom"'));
  for (const copy of ['aria-label="Recorded simulation replay"', "algorithmControl", "closure-status", "blocked cells", 'title="Play / pause (Space)"', "Priority", "Battery"]) {
    assert.ok(page.includes(copy), copy);
  }
});

test("removes the bottom-right Delivered meter and switches algorithms without mixing replays", async () => {
  const [page, picker, css] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/algorithm-picker.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /className="task-progress"|role="progressbar"/);
  assert.doesNotMatch(css, /\.task-progress[\s>{]/);
  assert.match(page, /<TaskProgress replay=\{replay\} time=\{time\}/);
  for (const retained of ["fetch(algorithm.file", "new AbortController", "controller.abort()", "controller.signal.aborted", "parseFleetGallery(data, algorithm.label)", 'get("algorithm")', 'get("case")', 'set("algorithm", algorithm.id)', "setTime(0)", "setPlaying(false)", "chooseAlgorithm", "setLoadingAlgorithm(true)", "Retry", "Dismiss replay error"]) assert.ok(page.includes(retained), retained);
  assert.match(picker, /Planning algorithm/);
  assert.match(picker, /disabled=\{loading\}/);
  assert.match(picker, /fleetAlgorithms\.map/);
  assert.match(css, /\.algorithm-picker \{[^}]*pointer-events: auto/);
});

test("keeps interface copy and shipped replay labels in English", async () => {
  const app = new URL("../app/", import.meta.url);
  const paths = (await readdir(app, { recursive: true })).filter(path => /\.(tsx?|css)$/.test(path));
  for (const path of paths) {
    const source = await readFile(new URL(path, app), "utf8");
    assert.doesNotMatch(source, /\p{Script=Han}/u, path);
  }
  const artifact = await readFile(new URL("../public/fleet-demo.json", import.meta.url), "utf8");
  assert.doesNotMatch(artifact, /\p{Script=Han}/u, "Fleet replay labels");
});

test("omits map dimensions and redundant fleet totals while keeping layout selection", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  for (const removed of ["grid-size", "overview-strip", "overview-metrics", "floor-heading"]) {
    assert.ok(!page.includes(removed), removed);
    assert.ok(!css.includes(removed), `Unused ${removed} styles are removed`);
  }
  assert.doesNotMatch(page, /pad\(vehicles\.length\)|activeCount|chargingCount/);
  assert.doesNotMatch(page, /className="layout-toolbar"/);
  assert.match(page, /Factory layout/);
  assert.match(page, /gallery\.cases\.map/);
});

test("keeps layout selection and the repository link without a Statistics entry", async () => {
  const page = await readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8");
  const header = page.slice(page.indexOf('<header className="app-header">'), page.indexOf('</header>'));
  const actions = header.slice(header.indexOf('<div className="header-actions">'));
  assert.match(actions, /className="layout-picker"/);
  assert.match(actions, /View repository on GitHub/);
  assert.doesNotMatch(header, /statistics-toggle|Statistics|view-switcher|recording-label|>Map<|>Replay</);
  assert.match(header, /className="brand" href="#workspace" aria-label="FleetLab home"/);
});

test("shares a distinctive routing mark and fleet colors without adding decorative copy", async () => {
  const [page, mark, favicon, css] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/brand-mark.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/favicon.svg", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const path = mark.match(/<path d="([^"]+)"/)[1];
  assert.ok(favicon.includes(path), "App and browser tab share the same mark");
  const endpoints = [...mark.matchAll(/<circle cx="([^"]+)" cy="([^"]+)" r="2.2"/g)];
  assert.equal(endpoints.length, 4, "Four endpoints represent coordinated routes, not the old A monogram");
  for (const [, x, y] of endpoints) assert.ok(favicon.includes(`cx="${x}" cy="${y}" r="2.2"`));
  assert.match(mark, /viewBox="0 0 40 40"/);
  assert.match(mark, /aria-hidden="true" focusable="false"/);
  assert.match(page, /<BrandMark/);
  assert.match(page, /className="brand-name">FleetLab</);
  assert.match(page, /className="loading-mark">FleetLab</);
  assert.match(page, /aria-label="FleetLab home"/);
  assert.doesNotMatch(page, />adaptive<|Adaptive Agent Lab home/);
  assert.match(page, /ForkliftGlyph loaded=\{isVehicleLoaded\(robot\)\}/);
  assert.match(page, /--owner-color/);
  assert.match(css, /--accent: #c9ee96/);
  assert.doesNotMatch(css, /@font-face|fonts\.googleapis/);
});

test("labels coordinates and metrics as recorded grid state rather than continuous telemetry", async () => {
  const page = await readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8");
  for (const copy of ["Grid cell", "gridCellHint", "simulationStepHint", "Chargers", "Pickup grid cell", "Delivery grid cell", "vehicleStatusLabel(robot)"]) assert.ok(page.includes(copy), copy);
  assert.doesNotMatch(page, />Position<|>Distance<|>Docks<|>Elapsed<|Distance \(cells\)|>Done</);
  assert.ok(page.includes("robot.position.join"), "Fleet cards continue to report actual recorded integer positions");
});

test("removes the bottom forklift status strip while retaining fleet status and playback", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page + css, /vehicle-telemetry|telemetry-identity|telemetry-battery|telemetry-icon|inspector-title|Selected forklift status/);
  for (const retained of ['aria-label="Fleet status"', 'vehicleStatusLabel(robot)', 'className="vehicle-battery-label"', 'className="vehicle-position"', 'aria-label="Replay transport"', 'aria-label="Playback speed"']) assert.ok(page.includes(retained), retained);
  assert.match(page, /<WarehouseScene[^\n]+\n\s*<\/div>\n\s*<div className="replay-controls">/);
});

test("keeps task progress above an independently scrolling task queue without pagination", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const right = page.slice(page.indexOf('<div className="operations-panel">'));
  assert.match(right, /<TaskProgress replay=\{replay\} time=\{time\}/);
  assert.ok(right.indexOf('<TaskProgress') < right.indexOf('className={"tasks-panel'), "Task progress precedes Tasks in the right column");
  assert.doesNotMatch(right, /chargers-panel|charger-list/);
  assert.match(right, /filteredOrders\.map/);
  assert.match(right, /key=\{replay\.caseId \+ "-" \+ taskFilter\}/);
  assert.match(right, /aria-label="Task list" tabIndex=\{0\} data-task-scroll/);
  assert.match(css, /\.task-list \{[^}]*overflow-y: auto;[^}]*overscroll-behavior-y: contain/);
  assert.doesNotMatch(page + css, /order-pagination|visiblePage|setOrderPage|Task pages|Next tasks|Previous tasks/);
});

test("omits transport readouts and gives fleet activity and battery their own dynamic colors", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page + css, /time-readout|replay-caption|nextEvent|Jump to next event/);
  for (const retained of ['aria-valuetext={`Step ${time} of ${maximumTime}`}', 'aria-label="Scenario event shortcuts"', 'aria-label="Playback speed"', 'aria-label="Replay transport"']) assert.ok(page.includes(retained), retained);
  assert.match(page, /data-state=\{fleetTone\}/);
  assert.match(page, /data-state=\{stateTone\} data-battery=\{batteryTone\}/);
  assert.match(page, /"--vehicle-color": vehicle.color, "--status-color": statusColors\[stateTone\], "--battery-color": batteryColors\[batteryTone\]/);
  assert.match(css, /\.vehicle-status \{[^}]*color: var\(--status-color\)/);
  assert.match(css, /\.vehicle-battery-label \{[^}]*color: var\(--battery-color\)/);
  assert.match(css, /\.vehicle-battery-track i \{ background: var\(--battery-color\)/);
});

test("centers playback and speed controls together as one compact group", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const row = css.match(/\.transport-row \{([^}]+)\}/)[1];
  assert.match(row, /display: flex/);
  assert.match(row, /justify-content: center/);
  assert.match(row, /gap: 24px/);
  assert.doesNotMatch(row, /grid-template-columns|space-between/);
  assert.doesNotMatch(css.match(/\.speed-control \{([^}]+)\}/)[1], /margin-left: auto/);
});

test("omits the bottom legend while keeping scene markers and charger status", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page + css, /map-legend|legend-route|legend-pickup|legend-dropoff|legend-charger|legend-closure|Map legend/);
  for (const retained of ['routes: currentTaskRoutes(replay, time)', 'blocked: frame.blocked, orderStates', '<WarehouseScene', 'className="chargers-panel side-panel"']) assert.ok(page.includes(retained), retained);
});

test("uses concise layout-based scene names without changing replay identifiers", async () => {
  const page = await readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8");
  for (const mapping of ['"rack-maze": "Central Aisle"', '"parallel-aisles": "Long Aisles"', '"cross-dock": "Mixed Layout"', 'serpentine: "Offset Aisles"']) assert.ok(page.includes(mapping), mapping);
  assert.match(page, /<option value=\{item.caseId\} key=\{item.caseId\}>\{layoutNames\[item.caseId\] \?\? item.label\}/);
  assert.match(page, /url.searchParams.set\("case", id\)/);
});

test("gives every charging station its own status-colored charger icon", async () => {
  const [page, css, icons] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ui-icon.tsx", import.meta.url), "utf8"),
  ]);
  const cards = page.slice(page.indexOf('scenario.chargingStations.map'), page.indexOf('<aside className={"fleet-panel'));
  assert.match(cards, /className="charger-symbol"><Icon name="charger"/);
  assert.doesNotMatch(cards, /<Icon name="bolt"/);
  assert.match(icons, /charger: "M2 21h13/);
  assert.match(css, /\.charger-symbol \{[^}]*color: var\(--charger-color\)/);
  assert.match(css, /\.charger-card\.is-charging \{ --charger-color: var\(--accent\)/);
  assert.match(css, /\.charger-card\.is-occupied \{ --charger-color: var\(--amber\)/);
  assert.match(css, /\.charger-card-heading \{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.charger-battery \{[^}]*white-space: nowrap/);
});

test("parenthesizes task coordinates and anchors a vertical camera toolbar at the scene corner", async () => {
  const [page, css, scene] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/warehouse-scene.tsx", import.meta.url), "utf8"),
  ]);
  assert.ok(page.includes('className="task-coordinate">({order.pickup.x}, {order.pickup.y})'));
  assert.ok(page.includes('className="task-coordinate">({order.dropoff.x}, {order.dropoff.y})'));
  assert.match(css, /\.scene-camera-tools \{[^}]*right: 10px; bottom: 10px/);
  assert.match(css, /\.camera-controls \{[^}]*flex-direction: column/);
  assert.doesNotMatch(scene + css, /scene-bottom-bar/);
  assert.ok(scene.indexOf('aria-label="Zoom in"') < scene.indexOf('aria-label="Camera zoom"'));
  assert.ok(scene.indexOf('aria-label="Camera zoom"') < scene.indexOf('aria-label="Zoom out"'));
  for (const label of ['Top view', 'Reset camera', 'Zoom in', 'Zoom out']) assert.ok(scene.includes('aria-label="' + label + '"'));
});

test("groups task identity, aligned endpoints and exact priority in compact accessible cards", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  for (const part of ["task-identity", "task-card-body", "task-endpoints", "task-coordinate", "task-priority"]) {
    assert.ok(page.includes('className="' + part + '"'), part);
  }
  assert.match(page, /task-endpoint-label">Pickup/);
  assert.match(page, /task-endpoint-label">Delivery/);
  assert.match(page, /<span>Priority<\/span><strong><Icon name="priority" \/>\{order.priority\}/);
  assert.match(page, /aria-label=\{`\$\{isOrderMarkerVisible\(state\) \? "Locate" : "Inspect"\} task[^`]+Pickup[^`]+Delivery[^`]+Priority/);
  assert.match(page, /aria-pressed=\{selectedOrderId === order.id\}/);
  assert.match(css, /\.task-card-body \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.task-coordinate \{[^}]*font-variant-numeric: tabular-nums/);
  assert.doesNotMatch(page + css, /task-card-meta|route-connector|className="task-route"/);
});

test("hides completed task markers even when their history card is selected", async () => {
  const [page, renderer] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/warehouse-renderer.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /visibleSelectedOrderId = [^\n]+isOrderMarkerVisible\(orderStates\[index\]\)/);
  assert.match(renderer, /group\.visible = isOrderEndpointVisible\(state, endpoint\)/);
  assert.match(renderer, /if \(!group\.visible\) return/);
  assert.match(renderer, /if \(highlighted && !marker\.label\)/);
  assert.match(renderer, /marker\.label\.visible = highlighted/);
  assert.doesNotMatch(renderer, /state === "delivered" \? 0\.22/);
});

test("shows every forklift's current task route independently of selection", async () => {
  const [page, css, model, renderer] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/maze-model.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/warehouse-renderer.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page + css, /Look-ahead|lookAheadHint|showFuture|setShowFuture|toggle-control/);
  assert.doesNotMatch(page + model + renderer, /futureRoute|referenceRoute|frameRobots|shouldAnimateMove|referencePosition|futureSegments/);
  assert.match(model, /fleet: MazeRobot\[\]/);
  assert.match(model, /routes: Record<string, TaskRoute \| null>/);
  assert.match(page, /routes: currentTaskRoutes\(replay, time\)/);
  assert.doesNotMatch(page + model + renderer, /primaryRoute|this\.plannedRoute|this\.trailRobot/);
  for (const expression of ["this.routes.get(robot.id)", "this.routes.set(robot.id, route)", "frame.routes[robot.id]", "this.updateRoute(route.solid, trail.segments, robot.color", "this.updateRoute(route.planned, routeSegments(taskRoute.planned), robot.color", "this.clearVehicleRoute(route)", "this.updateTrailTip(route)", "this.updatePlannedLead(route)", 'canvas.dataset.routeScope = "fleet"', "this.routes.clear()"]) assert.ok(renderer.includes(expression), expression);
  assert.match(renderer, /const solid = this\.makeRoute\(false, lane\)/);
  assert.match(renderer, /const planned = this\.makeRoute\(true, lane\)/);
  assert.match(renderer, /dashedRouteSegments\(\[lead\.edge\], progress\)/);
});

test("forklift speech bubbles follow rendered positions and preserve camera interactions", async () => {
  const [page, renderer, notices, css] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/warehouse-renderer.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/forklift-notices.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /notices: fleetNoticesAt\(replay, time\)/);
  assert.match(renderer, /this\.notices\?\.step\(frame\.time, frame\.notices, now\)/);
  assert.match(renderer, /robot\.group\.position\.clone\(\).*project\(this\.camera\)/);
  assert.match(renderer, /this\.notices\?\.dispose\(\)/);
  assert.match(notices, /setAttribute\("aria-live", "polite"\)/);
  assert.match(notices, /clearTimeout\(this\.wakeup\)/);
  assert.match(css, /\.forklift-notices \{[^}]*pointer-events: none/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.forklift-notice \{ animation: none/);
});

test("removes the Statistics view and its unused styles while retaining the map and algorithms", async () => {
  const [page, css, components] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readdir(new URL("../app/components/", import.meta.url)),
  ]);
  assert.doesNotMatch(page + css, /FleetStatistics|setView|statistics-toggle|statistics-card|results-panel|results-heading|vehicle-bar-chart|metric-switch|comparison-bar-track/);
  assert.ok(!components.includes("fleet-statistics.tsx"));
  assert.match(page, /<section className="map-panel"/);
  assert.match(page, /<AlgorithmPicker value=\{algorithmId\}/);
  assert.match(page, /<WarehouseScene/);
});

test("keeps chargers above an independently scrolling fleet and retains task history", async () => {
  const [page, progress, css] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/task-progress.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const sidebar = page.slice(page.indexOf('<div className="fleet-sidebar">'), page.indexOf('<section className="map-panel"'));
  assert.match(sidebar, /className="chargers-panel side-panel"/);
  assert.ok(sidebar.indexOf('className="chargers-panel') < sidebar.indexOf('<aside'));
  assert.match(sidebar, /chargingStationState\(station, frame\)/);
  for (const copy of ["Charging", "Occupied", "Unoccupied", "Vehicle battery level", "Inspect AGV"]) assert.ok(sidebar.includes(copy), copy);
  assert.doesNotMatch(sidebar, /TaskProgress|dock-status/);
  assert.match(sidebar, /tabIndex=\{0\} data-fleet-scroll hidden=\{fleetCollapsed\}/);
  assert.match(page, /closest\([^\n]+\[data-fleet-scroll\]/);
  assert.doesNotMatch(page + css, /fleet-is-collapsed/);
  for (const copy of ['Task progress', 'role="img"', 'aria-labelledby=', 'taskHistory(replay, time)', 'Released', 'Delivered']) assert.ok(progress.includes(copy), copy);
  assert.match(css, /\.fleet-cards \{[^}]*overflow-y: auto;[^}]*overscroll-behavior-y: contain/);
  assert.match(css, /\.vehicle-card \{[^}]*flex: 0 0 auto;[^}]*min-height: 124px/);
  assert.match(css, /\.fleet-panel\.is-collapsed \{ flex: 0 0 54px/);
});

test("gives the scene symmetric bounds with floating title and camera tools", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.scene-canvas \{[^}]*inset: 8px;/);
  assert.match(css, /\.map-panel \{ position: relative/);
  assert.match(css, /\.map-heading \{ position: absolute; top: 0; left: 0; right: 0;/);
  assert.match(css, /\.map-heading \{[^}]*pointer-events: none/);
  assert.match(css, /\.scene-camera-tools \{ position: absolute; right: 10px; bottom: 10px;/);
});

test("gives task progress translucent areas and accurately positioned axis ticks", async () => {
  const [progress, css] = await Promise.all([
    readFile(new URL("../app/components/task-progress.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(progress, /const chartId = useId\(\)/);
  for (const series of ["released", "delivered"]) {
    assert.ok(progress.includes('taskAreaPath(history, "' + series + '", maximum)'));
    assert.ok(progress.includes('fill={`url(#${chartId}-' + series + '-fill)`}'));
  }
  assert.equal((progress.match(/<linearGradient /g) ?? []).length, 2);
  assert.match(progress, /stopOpacity="0\.24"/);
  assert.match(progress, /stopOpacity="0\.04"/);
  assert.match(progress, /className="chart-axis-line" d="M0,0V240H1000" vectorEffect="non-scaling-stroke"/);
  assert.ok(progress.includes('step / Math.max(time, 1) * 100'));
  assert.ok(progress.includes('100 - tick * 25'));
  assert.match(css, /\.chart-x-tick \{ position: absolute/);
  assert.match(css, /\.chart-axis-line \{[^}]*stroke-linejoin: round/);
});
