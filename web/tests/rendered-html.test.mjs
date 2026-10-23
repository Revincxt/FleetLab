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
  assert.match(html, /<p>Loading\.\.\.<\/p>/);
  assert.match(html, /FleetLab/);
  assert.doesNotMatch(html, /Adaptive Agent Lab/);
  assert.match(html, /lang="en"/);
  assert.doesNotMatch(html, /\p{Script=Han}/u);
  assert.match(html, /name="theme-color" content="#101114"/);
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
  for (const text of ["Fleet status", "Task queue", "algorithmControl", "task-filters", "inspectTask", "highlightedOrderId", "Recorded simulation replay"]) assert.ok(page.includes(text), text);
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

test("uses shared native-like picker menus without focus frames or legacy pointer-focus flags", async () => {
  const [page, picker, css] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/algorithm-picker.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const focus = css.match(/\.picker-trigger:focus \{([^}]+)\}/)?.[1];
  assert.ok(focus, "Only picker triggers suppress the inner focus frame");
  assert.match(focus, /outline: none/);
  const indicator = css.match(/\.compact-picker:has\(\.picker-trigger:focus-visible\) \{([^}]+)\}/)?.[1];
  assert.ok(indicator, "Keyboard users retain a visible focus indicator on the picker shell");
  assert.match(indicator, /box-shadow: inset 0 -2px 0 #a2afb9/);
  assert.doesNotMatch(focus + indicator, /var\(--accent\)|#c9ee96/);
  assert.match(css, /button:focus-visible, a:focus-visible, select:focus-visible, input:focus-visible \{ outline: 2px solid var\(--selection\)/);
  assert.match(page, /<CompactPicker className="layout-picker" label="Factory layout"/);
  assert.match(page, /value=\{replay\.caseId\} disabled=\{loadingAlgorithm\} options=\{layoutOptions\} onChange=\{chooseLayout\}/);
  assert.match(picker, /<CompactPicker className="algorithm-picker" label="Planning algorithm"/);
  assert.match(picker, /value=\{value\} disabled=\{loading\} options=\{algorithmOptions\} onChange=\{onChange\}/);
  assert.doesNotMatch(page + picker + css, /<select\b|data-pointer-focus|\.layout-picker select|\.algorithm-picker select/);
  assert.match(css, /\.picker-popover \{[^}]*width: max-content;[^}]*max-width: calc\(100vw - 32px\)/);
  assert.match(css, /\.picker-menu \{[^}]*border-radius: 13px;[^}]*background: linear-gradient\([^;]+\), #e6edeeb8/);
  assert.match(css, /\.picker-menu \{[^}]*-webkit-backdrop-filter: saturate\(160%\) blur\(18px\); backdrop-filter: saturate\(160%\) blur\(18px\)/);
  assert.match(css, /\.picker-menu \{[^}]*--picker-row-height: 22px;[^}]*padding: 4px/);
  assert.match(css, /\.picker-menu \{[^}]*font: 500 var\(--text-body\)\/16px var\(--sans\);[^}]*letter-spacing: normal/);
  assert.match(css, /\.picker-option \{[^}]*height: var\(--picker-row-height\)/);
  assert.match(css, /\.picker-option\[aria-selected="true"\] \{ font-weight: 600/);
  assert.match(css, /\.picker-option\[data-active="true"\] \{ color: #ffffff/);
});

test("gives the full-width header a routing signature and an unframed repository link", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const header = page.slice(page.indexOf('<header className="app-header">'), page.indexOf('</header>'));
  assert.match(header, /className="brand-name">Fleet<span>Lab<\/span><\/span>/);
  assert.match(header, /<svg className="header-routes"[^>]*aria-hidden="true" focusable="false"/);
  assert.match(header, /className="repository-link" href="https:\/\/github\.com\/Revincxt\/FleetLab"/);
  assert.doesNotMatch(header, /<button|<h[1-6]|role="status"|aria-live|Fleet control|Industrial workspace/);
  const headerStyle = css.match(/\.app-header \{([^}]+)\}/)[1];
  assert.match(headerStyle, /position: relative; z-index: 3/);
  assert.match(headerStyle, /flex: 0 0 64px; margin: 0;/);
  assert.match(headerStyle, /border: 0; border-bottom: 1px solid[^;]+; border-radius: 0/);
  assert.doesNotMatch(headerStyle, /overflow: hidden/);
  assert.doesNotMatch(css, /\.app-header \{[^}]*margin-inline/);
  assert.match(css, /\.header-routes \{[^}]*pointer-events: none/);
  assert.doesNotMatch(css.match(/\.header-actions \{([^}]+)\}/)[1], /border:|background:|box-shadow:/);
  assert.match(css, /\.repository-link \{[^}]*border: 0;[^}]*background: transparent;[^}]*box-shadow: none/);
  assert.doesNotMatch(css.match(/\.repository-link:hover \{([^}]+)\}/)[1], /background:|border:|box-shadow:/);
  assert.doesNotMatch(css, /\.repository-link::before/);
  assert.match(css, /@media \(max-width: 900px\) \{[^}]*\}\s*\.header-routes \{ display: none/);
});

test("picker menus close after pointer exit without trapping keyboard focus or touch input", async () => {
  const picker = await readFile(new URL("../app/components/compact-picker.tsx", import.meta.url), "utf8");
  for (const retained of ['role="combobox"', 'role="listbox"', 'role="option"', 'aria-expanded={expanded}', 'aria-activedescendant=', 'aria-selected={option.value === value}', 'key === "Tab"', 'key === "Escape"', 'key === "Enter"', '"ArrowDown", "ArrowUp", "Home", "End"']) {
    assert.ok(picker.includes(retained), retained);
  }
  assert.match(picker, /onPointerEnter=\{cancelClose\}/);
  assert.match(picker, /event\.pointerType !== "mouse" \|\| interaction\.current !== "pointer"/);
  assert.match(picker, /window\.setTimeout\(close, 180\)/);
  assert.match(picker, /window\.clearTimeout\(closeTimer\.current\)/);
  assert.match(picker, /document\.addEventListener\("pointerdown", outside, true\)/);
  assert.match(picker, /document\.removeEventListener\("pointerdown", outside, true\)/);
  assert.match(picker, /if \(options\[index\]\.value !== value\) onChange/);
  assert.doesNotMatch(picker, /\.blur\(|addEventListener\("pointermove"|setInterval/);
});

test("picker motion follows the active option and respects reduced-motion preferences", async () => {
  const [picker, css] = await Promise.all([
    readFile(new URL("../app/components/compact-picker.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(picker, /"--picker-index": activeIndex/);
  assert.match(css, /\.picker-menu::before \{[^}]*translateY\(calc\(var\(--picker-index, 0\) \* var\(--picker-row-height\)\)\)/);
  assert.match(css, /@keyframes picker-menu-in/);
  assert.match(css, /\.layout-picker \.picker-menu \{ transform-origin: top right/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation: none !important; transition: none !important/);
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
  assert.match(page, /className="brand-name">Fleet<span>Lab<\/span><\/span>/);
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
  assert.ok(right.indexOf('<TaskProgress') < right.indexOf('className="tasks-panel'), "Task progress precedes Tasks in the right column");
  assert.doesNotMatch(right, /chargers-panel|charger-list/);
  assert.match(right, /filteredOrders\.map/);
  assert.match(right, /<h2><Icon name="box" \/>Tasks<\/h2>/);
  assert.doesNotMatch(right + css, /title="Released tasks"|\.side-heading h2 small/);
  assert.match(right, /key=\{replay\.caseId \+ "-" \+ taskFilter\}/);
  assert.match(right, /aria-label="Task list" tabIndex=\{0\} data-task-scroll/);
  assert.match(css, /\.task-list \{[^}]*overflow-y: auto;[^}]*overscroll-behavior-y: contain/);
  assert.doesNotMatch(page + css, /order-pagination|visiblePage|setOrderPage|Task pages|Next tasks|Previous tasks/);
});

test("groups compact task totals in the chart header without a redundant percentage", async () => {
  const [progress, css] = await Promise.all([
    readFile(new URL("../app/components/task-progress.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const header = progress.slice(progress.indexOf('<header className="chart-heading">'), progress.indexOf('</header>'));
  assert.match(header, /Task progress/);
  assert.match(header, /className="chart-legend" aria-label="Task totals at selected step"/);
  assert.match(header, /chart-legend-label">Released<\/span>[\s\S]*latest\.released/);
  assert.match(header, /chart-legend-label">Delivered<\/span>[\s\S]*latest\.delivered/);
  assert.doesNotMatch(header, /Delivered \/ released tasks|Math\.round|latest\.delivered \/ latest\.released|%/);
  assert.doesNotMatch(css, /\.chart-heading > span/);
  assert.match(css, /\.chart-legend \{[^}]*grid-template-columns: repeat\(2, max-content\);[^}]*margin-left: auto/);
  assert.match(css, /\.chart-heading h2 \{ font-size: var\(--text-title\)/);
  assert.match(css, /\.chart-legend > span \{[^}]*font-size: var\(--text-caption\)/);
  assert.match(css, /\.chart-legend strong \{ font-size: var\(--text-value\); font-weight: 600;[^}]*font-variant-numeric: tabular-nums/);
});

test("gives task progress a matching decorative panel-heading icon", async () => {
  const [progress, icons, css] = await Promise.all([
    readFile(new URL("../app/components/task-progress.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ui-icon.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(progress, /import \{ Icon \} from "\.\/ui-icon"/);
  assert.match(progress, /<h2 id=\{`\$\{chartId\}-heading`\}><Icon name="chart" \/>Task progress<\/h2>/);
  assert.match(icons, /chart: "[^"]+"/);
  assert.match(icons, /aria-hidden="true"/);
  assert.match(css, /\.side-heading h2 > \.icon, \.chart-heading h2 > \.icon \{ width: 15px; height: 15px; flex: 0 0 auto; color: var\(--faint\)/);
  assert.match(css, /\.chart-heading h2 \{[^}]*display: flex; align-items: center; gap: 9px; min-width: 0/);
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
  assert.match(row, /gap: 16px/);
  assert.match(row, /width: fit-content/);
  assert.match(row, /margin: 8px auto 0/);
  assert.doesNotMatch(row, /grid-template-columns|space-between/);
  assert.doesNotMatch(css.match(/\.speed-control \{([^}]+)\}/)[1], /margin-left: auto/);
});

test("uses a silver primary action and a compact segmented speed control without a framed footer", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const playback = css.slice(css.indexOf('.replay-controls {'), css.indexOf('.task-panel-content {'));
  const footer = playback.match(/\.replay-controls \{([^}]+)\}/)[1];
  assert.match(footer, /border: 0/);
  assert.match(footer, /background: transparent/);
  assert.doesNotMatch(playback, /var\(--accent\)|#c9ee96|#ddf5b9|#e2f7c4/);
  assert.match(playback, /\.transport-row \{[^}]*border-radius: 999px;[^}]*backdrop-filter: blur\(16px\)/);
  assert.match(playback, /\.transport-controls \.play-button \{[^}]*background: #e7ebf0;[^}]*color: #252a32;[^}]*border-radius: 50%/);
  assert.match(playback, /\.transport-controls \.play-button:hover:not\(:disabled\)/);
  assert.match(playback, /\.speed-control \{[^}]*border-radius: 999px;[^}]*padding: 3px;[^}]*background: #00000024/);
  assert.doesNotMatch(playback.match(/\.speed-control \{([^}]+)\}/)[1], /border-left|margin-left: auto/);
  assert.match(playback, /\.speed-control button\.is-active \{[^}]*background: #ffffff1c/);
  assert.match(playback, /\.replay-controls :is\(button, input\):focus-visible \{ outline: 2px solid var\(--replay-highlight\)/);
  assert.match(playback, /::-webkit-slider-runnable-track \{[^}]*var\(--replay-highlight\)/);
  assert.match(playback, /::-moz-range-progress \{[^}]*var\(--replay-highlight\)/);
  for (const retained of ['aria-label="Restart replay"', 'aria-label="Previous time step"', 'aria-label="Next time step"', 'aria-keyshortcuts="Space"', 'onChange={(event) => seek(Number(event.target.value))}', 'aria-pressed={speed === rate}', 'onClick={() => setSpeed(rate)}']) assert.ok(page.includes(retained), retained);
});

test("shares neutral surface layers while keeping operational colors independent of selection", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const token of ["--canvas: #101114", "--surface: #1a1c20", "--surface-raised: #23262b", "--surface-hover: #2b2e34", "--surface-inset: #14161a", "--selection: #c2cfdf"]) assert.ok(css.includes(token), token);
  for (const component of ["vehicle-card", "charger-card", "task-card"]) {
    const style = css.match(new RegExp(`\\.${component} \\{([^}]+)\\}`))[1];
    assert.match(style, /background: var\(--surface-raised\)/);
    assert.doesNotMatch(style, /backdrop-filter/, "Repeated cards do not blur or composite the moving scene");
  }
  assert.match(css, /\.task-filters \{[^}]*background: var\(--surface-inset\)/);
  assert.match(css, /\.charger-list \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); gap: 1px;[^}]*overflow: hidden/);
  assert.match(css, /\.charger-card \{[^}]*border: 0/);
  assert.match(css, /\.task-card\.is-selected \{[^}]*var\(--selection\)/);
  assert.match(css, /\.vehicle-status \{[^}]*color: var\(--status-color\)/);
  assert.match(css, /\.vehicle-battery-label \{[^}]*color: var\(--battery-color\)/);
  assert.match(css, /\.charger-card\.is-charging \{ --charger-color: var\(--accent\)/);
  assert.match(css, /\.series-delivered \{ --series-color: var\(--accent\)/);
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
  assert.match(page, /gallery\.cases\.map\(\(item\) => \(\{ value: item\.caseId, label: layoutNames\[item\.caseId\] \?\? item\.label \}\)\)/);
  assert.match(page, /url.searchParams.set\("case", id\)/);
});

test("gives every charging station its own status-colored charger icon", async () => {
  const [page, css, icons] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ui-icon.tsx", import.meta.url), "utf8"),
  ]);
  const cards = page.slice(page.indexOf('scenario.chargingStations.map'), page.indexOf('<aside className="fleet-panel'));
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
  assert.match(page, /visibleSelectedOrderId = [^\n]+isOrderMarkerVisible\(playback\.orderStates\[index\]\)/);
  assert.match(renderer, /group\.visible = isOrderEndpointVisible\(state, endpoint\)/);
  assert.match(renderer, /if \(!group\.visible\) return/);
  assert.match(renderer, /if \(highlighted && !marker\.label\)/);
  assert.match(renderer, /marker\.label\.visible = highlighted/);
  assert.match(renderer, /this\.createTaskMarkers = \(index\) =>/);
  assert.match(renderer, /if \(!markers\) \{ markers = this\.createTaskMarkers\(index\)/);
  assert.match(renderer, /this\.releaseTaskMarkers\(markers\); this\.orderMarkers\.delete\(index\)/);
  for (const expression of ["this.scene.remove(group)", "ink.dispose()", "this.materials.delete(ink)", "this.textures.delete(material.map)", "canvas.dataset.allocatedTaskPointCount"]) {
    assert.ok(renderer.includes(expression), expression);
  }
  assert.doesNotMatch(renderer, /this\.orderMarkers\.flat\(/);
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

test("reuses replay presentation and only refreshes shadows when scene objects change", async () => {
  const [page, scene, chart, renderer] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/warehouse-scene.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/task-progress.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/warehouse-renderer.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /const playback = useMemo\(/);
  assert.match(page, /const sceneFrame = useMemo<MazeFrame \| null>/);
  assert.match(page, /const filteredOrders = useMemo\(/);
  assert.match(scene, /export default memo\(WarehouseScene\)/);
  assert.match(chart, /export default memo\(TaskProgress\)/);
  assert.match(renderer, /shadowMap\.autoUpdate = false/);
  assert.match(renderer, /if \(robot\.motion\) this\.renderer\.shadowMap\.needsUpdate = true;\s+this\.advanceRobot/);
  assert.match(renderer, /if \(this\.workers\.some\(worker => worker\.motion\)\) this\.renderer\.shadowMap\.needsUpdate = true/);
  assert.match(renderer, /update\(frame: MazeFrame\) \{\s+if \(this\.disposed\) return;\s+this\.renderer\.shadowMap\.needsUpdate = true/);
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
  assert.match(renderer, /this\.positionScratch\.copy\(robot\.group\.position\);\s+point\.y \+= 1\.65;\s+point\.project\(this\.camera\)/);
  assert.match(renderer, /this\.notices\?\.dispose\(\)/);
  assert.match(notices, /setAttribute\("aria-live", "polite"\)/);
  assert.match(notices, /clearTimeout\(this\.wakeup\)/);
  assert.match(css, /\.forklift-notices \{[^}]*pointer-events: none/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.forklift-notice \{ animation: none/);
});

test("shares immutable charger resources and reuses scratch vectors in the animation loop", async () => {
  const renderer = await readFile(new URL("../app/components/warehouse-renderer.ts", import.meta.url), "utf8");
  assert.match(renderer, /private readonly positionScratch = new THREE\.Vector3\(\)/);
  assert.match(renderer, /const chargerLabelGeometry = this\.geometry/);
  assert.match(renderer, /const chargerLabelMaterial = this\.material/);
  const chargers = renderer.slice(renderer.indexOf("this.scenario.chargingStations.forEach"), renderer.indexOf("// Shared floor stencils"));
  assert.match(chargers, /new THREE\.Mesh\(chargerLabelGeometry, chargerLabelMaterial\)/);
  assert.doesNotMatch(chargers, /this\.labelTexture\(|new THREE\.PlaneGeometry|new THREE\.MeshBasicMaterial/);
  for (const [start, end] of [["private advanceRobot", "private updateTrailTip"], ["private updatePlannedLead", "private updateWorkers"], ["private advanceWorkers", "private makeClosure"]]) {
    assert.doesNotMatch(renderer.slice(renderer.indexOf(start), renderer.indexOf(end)), /new THREE\.Vector3|\.clone\(/);
  }
  for (const retained of ["this.geometries.forEach", "this.materials.forEach", "this.textures.forEach"]) assert.ok(renderer.includes(retained), retained);
});

test("uses the shared icon renderer and avoids redundant ready guards in visible camera controls", async () => {
  const [scene, icons, css] = await Promise.all([
    readFile(new URL("../app/components/warehouse-scene.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ui-icon.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(scene, /import \{ Icon \} from "\.\/ui-icon"/);
  for (const name of ["top", "reset", "minus", "plus"]) {
    assert.ok(scene.includes(`<Icon name="${name}" />`), name);
    assert.ok(icons.includes(`${name}: "`), name);
  }
  assert.match(scene, /\{ready \? <div className="scene-camera-tools">/);
  assert.match(scene, /disabled=\{zoom >= 275\}/);
  assert.match(scene, /disabled=\{zoom <= 65\}/);
  assert.doesNotMatch(scene, /CameraIcon|cameraIcons|disabled=\{!ready/);
  assert.doesNotMatch(css, /\.sr-only|\bcaption \{/);
  assert.match(css, /\.camera-controls svg \{ width: 17px; height: 17px/);
  assert.match(css, /\.scene-error > svg \{ width: 16px; height: 16px/);
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
  assert.match(sidebar, /tabIndex=\{0\} data-fleet-scroll>/);
  assert.match(page, /closest\([^\n]+\[data-fleet-scroll\]/);
  for (const copy of ['Task progress', 'role="img"', 'aria-labelledby=', 'taskHistory(replay, time)', 'Released', 'Delivered']) assert.ok(progress.includes(copy), copy);
  assert.match(css, /\.fleet-cards \{[^}]*overflow-y: auto;[^}]*overscroll-behavior-y: contain/);
  assert.match(css, /\.vehicle-card \{[^}]*flex: 0 0 auto;[^}]*min-height: 124px/);
});

test("keeps fleet and task panels permanently expanded without collapse controls", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page + css, /fleetCollapsed|setFleetCollapsed|tasksCollapsed|setTasksCollapsed|collapse-button|is-collapsed|(?:Expand|Collapse) (?:fleet|task) panel/);
  for (const panel of ["fleet", "tasks"]) {
    const start = page.indexOf(`<aside className="${panel}-panel side-panel"`);
    assert.ok(start >= 0, `${panel} panel keeps a fixed, expanded class`);
    const content = page.slice(start, page.indexOf("</aside>", start));
    const heading = content.match(/<header className="side-heading">[\s\S]*?<\/header>/)?.[0];
    assert.ok(heading, `${panel} retains its heading`);
    assert.doesNotMatch(heading, /<button|aria-expanded/);
    assert.doesNotMatch(content, /\shidden(?:=|\s|>)/);
  }
  assert.match(page, /<div className="task-panel-content">/);
});

test("gives the scene symmetric bounds with floating title and camera tools", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.scene-canvas \{[^}]*inset: 8px;/);
  assert.match(css, /\.map-panel \{ position: relative/);
  assert.match(css, /\.map-heading \{ position: absolute; top: 0; left: 0; right: 0;/);
  assert.match(css, /\.map-heading \{[^}]*pointer-events: none/);
  assert.match(css, /\.scene-camera-tools \{ position: absolute; right: 10px; bottom: 10px;/);
});

test("contains scene overlays below the algorithm picker header", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/components/fleet-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const stage = css.match(/\.map-stage \{([^}]+)\}/)[1];
  const heading = css.match(/\.map-heading \{([^}]+)\}/)[1];
  assert.match(stage, /position: relative; z-index: 0;/, "Scene children form their own lower stacking context");
  assert.ok(Number(heading.match(/z-index: (\d+)/)[1]) > Number(stage.match(/z-index: (\d+)/)[1]));
  const markup = page.slice(page.indexOf('<header className="map-heading">'), page.indexOf('<div className="replay-controls">'));
  assert.match(markup, /\{algorithmControl\}[\s\S]*<\/header>\s*<div className="map-stage is-3d">[\s\S]*className="closure-status"[\s\S]*<WarehouseScene/);
  assert.match(css, /\.closure-status \{[^}]*pointer-events: none/);
  assert.match(css, /\.algorithm-picker \{ pointer-events: auto/);
});

test("uses the header-to-panel spacing for all outer panel gaps and screen insets", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /--workspace-gap: 8px;/);
  assert.match(css, /\.control-workspace \{[^}]*gap: var\(--workspace-gap\); padding: var\(--workspace-gap\)/);
  for (const component of ["fleet-sidebar", "operations-panel"]) assert.match(css, new RegExp(`\\.${component} \\{[^}]*gap: var\\(--workspace-gap\\)`));
  const responsive = css.slice(css.indexOf("@media (max-width: 1300px)"));
  assert.doesNotMatch(responsive, /\.(?:control-workspace|fleet-sidebar|operations-panel) \{[^}]*(?:\bgap:|\bpadding(?:-\w+)?:)/);
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

test("reserves space beneath an independently sized plot for X-axis labels", async () => {
  const [progress, css] = await Promise.all([
    readFile(new URL("../app/components/task-progress.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(progress, /<div className="chart-plot-area">\s*<svg className="task-history-plot"/);
  assert.match(css, /\.task-progress-panel \{ flex: 0 0 244px/);
  assert.match(css, /\.task-progress-panel \{[^}]*padding: 14px 12px 10px/);
  assert.match(css, /\.task-history-chart \{[^}]*grid-template-columns: 18px minmax\(0, 1fr\); grid-template-rows: minmax\(0, 1fr\) 24px; grid-template-areas: "y plot" "\. x";[^}]*column-gap: 4px; padding-right: 8px/);
  assert.match(css, /\.chart-plot-area \{ grid-area: plot; position: relative; min-width: 0; min-height: 0/);
  assert.match(css, /\.task-history-plot \{ position: absolute; inset: 0; display: block; width: 100%; height: 100%/);
  assert.match(css, /\.chart-x-axis \{ grid-area: x/);
  assert.match(css, /\.chart-x-tick \{ position: absolute; top: 8px/);
  assert.doesNotMatch(progress + css, /chart-axis-unit|>Step</);
});

test("uses medium system text and semibold metrics without introducing another font", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const [role, size] of [["caption", 10], ["body", 12], ["title", 13], ["value", 14], ["display", 20]]) assert.ok(css.includes(`--text-${role}: ${size}px;`));
  assert.match(css, /body \{[^}]*font: 500 var\(--text-body\)\/1\.5 var\(--sans\)/);
  assert.match(css, /\.picker-trigger \{[^}]*font: 500 var\(--text-body\)\/16px var\(--sans\)/);
  assert.match(css, /\.side-heading h2 \{[^}]*font-size: var\(--text-title\)/);
  assert.match(css, /\.vehicle-card-heading > strong \{ font-size: var\(--text-value\)/);
  assert.match(css, /\.vehicle-battery-label strong \{ color: inherit; font-size: var\(--text-body\)/);
  assert.match(css, /\.task-filters button \{[^}]*font-size: var\(--text-body\)/);
  assert.match(css, /\.task-owner \{[^}]*font-size: var\(--text-caption\)/);
  assert.doesNotMatch(css, /font-size:\s*\d|font-weight: 650|is-unassigned/);
  for (const selector of ["vehicle-details b", "vehicle-battery-label strong", "charger-card-heading strong", "task-coordinate", "speed-control button", "chart-legend strong"]) {
    const style = css.match(new RegExp(`\\.${selector} \\{([^}]+)\\}`))[1];
    assert.match(style, /font-weight: 600/, selector);
  }
  assert.doesNotMatch(css, /@font-face|fonts\.googleapis/);
});
