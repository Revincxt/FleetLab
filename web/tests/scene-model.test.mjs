import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import { dashedRouteSegments, isAdjacent, isOrderEndpointVisible, isOrderMarkerVisible, progressiveRoute, routeCapacity, routeSegments, shouldAnimateFleetMove, toWorld } from "../app/components/maze-model.ts";
import { createRobotMotion, retimeRobotMotion, sampleRobotMotion } from "../app/components/replay-motion.ts";
import { factoryFixtures, safetyEdges } from "../app/components/factory-layout.ts";
import { chargingStationState, parseFleetGallery, displayedOrderState, isVehicleLoaded, releasedOrderEntries } from "../app/components/fleet-model.ts";
import { fleetAlgorithms, fleetAlgorithm } from "../app/components/fleet-algorithms.ts";
import { buildForkliftPayload, LOADED_FORK_LIFT } from "../app/components/forklift-payload.ts";
import { buildIndustrialForklift } from "../app/components/factory-forklift.ts";
import { currentTaskRoute, decodePlannedRoute } from "../app/components/task-route-model.ts";
import { taskAreaPath, taskHistory, taskStepPath, chartCeiling } from "../app/components/task-progress-model.ts";
import { batteryColors, batteryToneHints, eventLabels, fleetStatusTone, gridCellHint, orderLabels, simulationStepHint, statusColors, vehicleBatteryTone, vehicleStatusHint, vehicleStatusLabel, vehicleStatusTone } from "../app/components/fleet-terminology.ts";

const gallery = parseFleetGallery(JSON.parse(await readFile(new URL("../public/fleet-demo.json", import.meta.url), "utf8")));

test("compact task-state codes decode losslessly and reject corrupt encodings", async () => {
  const raw = JSON.parse(await readFile(new URL("../public/fleet-demo.json", import.meta.url), "utf8"));
  assert.equal(raw.schemaVersion, 2);
  const parsed = parseFleetGallery(raw);
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parseFleetGallery(parsed), parsed, "Legacy schema 1 remains readable");
  const codes = ["pending", "available", "picked_up", "delivered", "expired"];
  for (const [index, replay] of raw.cases.entries()) {
    assert.equal(replay.schemaVersion, 2);
    for (const [time, frame] of replay.frames.entries()) {
      assert.equal(typeof frame.orderStates, "string", "Parsing must not mutate the input");
      assert.equal(frame.orderStates.length, 225);
      assert.match(frame.orderStates, /^[0-4]+$/);
      const expected = Object.fromEntries(replay.scenario.orders.map((order, i) => [order.id, codes[Number(frame.orderStates[i])]]));
      assert.deepEqual(parsed.cases[index].frames[time].orderStates, expected);
      if (time && frame.orderStates === replay.frames[time - 1].orderStates) {
        assert.equal(parsed.cases[index].frames[time].orderStates, parsed.cases[index].frames[time - 1].orderStates);
      }
    }
  }
  for (const corrupt of ["", "0".repeat(224), "0".repeat(226), "5".repeat(225), [], {}]) {
    const replay = raw.cases[0];
    const broken = { ...replay, frames: [{ ...replay.frames[0], orderStates: corrupt }, ...replay.frames.slice(1)] };
    assert.throws(() => parseFleetGallery({ ...raw, cases: [broken] }), /Compact fleet task states/);
  }
});

test("three algorithms use separate deterministic runs on identical progressively released tasks", async () => {
  assert.deepEqual(fleetAlgorithms.map(item => item.id), ["coordinated-astar", "whca", "rhcr-pbs"]);
  assert.equal(fleetAlgorithm(null), fleetAlgorithms[0]);
  assert.equal(fleetAlgorithm("unknown"), fleetAlgorithms[0]);
  for (const algorithm of fleetAlgorithms) {
    assert.equal(fleetAlgorithm(algorithm.id), algorithm);
    assert.match(algorithm.file, /^\.\/fleet-[\w-]+\.json$/);
    const text = await readFile(new URL(`../public/${algorithm.file}`, import.meta.url), "utf8");
    assert.ok(Buffer.byteLength(text) < 100 * 1024 ** 2, "Each file fits GitHub's regular file limit");
    const raw = JSON.parse(text);
    let quoted = false;
    for (let i = 0; i < text.length - Number(text.endsWith("\n")); i++) {
      if (quoted && text[i] === "\\") { i++; continue; }
      if (text[i] === '"') quoted = !quoted;
      else if (!quoted && /\s/.test(text[i])) assert.fail("Whitespace outside JSON strings");
    }
    assert.equal(quoted, false);
    const candidate = parseFleetGallery(raw, algorithm.label);
    assert.throws(() => parseFleetGallery(raw, "Wrong planner"), /selected algorithm/);
    assert.deepEqual(candidate.cases.map(item => item.caseId), gallery.cases.map(item => item.caseId));
    for (const [index, replay] of candidate.cases.entries()) {
      const baseline = gallery.cases[index];
      assert.deepEqual(replay.scenario, baseline.scenario, "Map, releases, closures and battery rules are identical");
      assert.equal(replay.scenarioFingerprint, baseline.scenarioFingerprint);
      assert.deepEqual(replay.vehicles, baseline.vehicles);
      assert.deepEqual(replay.workforce, { count: 3, seed: 17, moveSteps: 3 });
      const initialState = frame => ({ ...frame, vehicles: frame.vehicles.map(({ plannedMoves, ...vehicle }) => { assert.equal(typeof plannedMoves, "string"); return vehicle; }) });
      assert.deepEqual(initialState(replay.frames[0]), initialState(baseline.frames[0]), "Initial world and dispatch match; solver plans may differ");
      assert.equal(replay.summary.completedOrders, 225);
      assert.equal(replay.summary.constraintViolations, 0);
      assert.equal(replay.summary.trafficWaits, 0);
      assert.equal(releasedOrderEntries(replay.scenario.orders, replay.frames[0]).length, 4);
      assert.equal(replay.frames.at(-1).completedOrders, 225);
      for (const [time, frame] of replay.frames.entries()) {
        const blocked = new Set(frame.blocked.map(p => p.x + ":" + p.y));
        const workers = new Set((frame.workers ?? []).flatMap(w => [w.position.join(":"), ...(w.transit ? [w.transit.slice(0, 2).join(":")] : [])]));
        for (const [i, vehicle] of frame.vehicles.entries()) {
          assert.equal(typeof vehicle.plannedMoves, "string");
          if (algorithm.id !== "coordinated-astar") assert.ok(vehicle.plannedMoves.length <= 16);
          const points = decodePlannedRoute({x:vehicle.position[0],y:vehicle.position[1]}, vehicle.plannedMoves);
          for (let j = 1; j < points.length; j++) {
            const p = points[j], key = p.x + ":" + p.y;
            if (isAdjacent(points[j - 1], p)) assert.equal(blocked.has(key), false);
            assert.equal(workers.has(key), false);
          }
          if (time + 1 < replay.frames.length) {
            const requested = replay.frames[time + 1].vehicles[i].requestedAction;
            assert.equal(vehicle.plannedMoves[0], ({ up: "U", down: "D", left: "L", right: "R" })[requested] ?? ".", "Plan is aligned with its decision snapshot");
          }
        }
      }
      if (algorithm.id !== "coordinated-astar") {
        assert.equal(replay.planner.algorithmId, algorithm.id);
        assert.equal(replay.planner.planningWindow, 16);
        assert.equal(replay.planner.replanningInterval, 4);
        assert.equal(replay.planner.fallback_waits, 0);
        assert.ok(replay.planner.expanded_nodes > replay.planner.planning_calls);
        if (algorithm.id === "rhcr-pbs") assert.ok(replay.planner.priority_nodes > replay.planner.planning_calls);
        else assert.equal(replay.planner.priority_nodes, 0);
        assert.ok(replay.frames.some((frame, time) => frame.vehicles.some((vehicle, i) =>
          vehicle.position.join() !== baseline.frames[time]?.vehicles[i].position.join()
        )), "Different planners produce different trajectories, not renamed copies");
      }
    }
  }
});

test("task progress retains every recorded count change without revealing future tasks", () => {
  for (const replay of gallery.cases) {
    for (const time of [0, 1, 94, 1200, replay.frames.length - 1]) {
      const history = taskHistory(replay, time);
      assert.equal(history[0].time, 0);
      assert.equal(history.at(-1).time, time);
      assert.equal(history.at(-1).released, releasedOrderEntries(replay.scenario.orders, replay.frames[time]).length);
      assert.equal(history.at(-1).delivered, replay.frames[time].completedOrders);
      let cursor = 0;
      for (let index = 0; index <= time; index++) {
        if (history[cursor + 1]?.time === index) cursor++;
        const frame = replay.frames[index];
        assert.equal(history[cursor].delivered, frame.completedOrders);
        assert.equal(history[cursor].released, releasedOrderEntries(replay.scenario.orders, frame).length);
      }
      assert.ok(history.every(point => point.time <= time));
    }
    assert.deepEqual(taskHistory(replay, 0), [{ time: 0, released: 4, delivered: 0 }]);
    assert.equal(taskHistory(replay, replay.frames.length - 1).at(-1).delivered, 225);
  }
});

test("chart scales handle zero data and count paths are stepwise rather than interpolated", () => {
  for (const value of [0, 1, 4, 13, 225, 4800]) {
    const maximum = chartCeiling(value);
    assert.ok(maximum >= value && maximum > 0);
    assert.ok(Number.isInteger(maximum / 4));
  }
  const points = [{ time: 0, released: 4, delivered: 0 }, { time: 5, released: 5, delivered: 1 }, { time: 10, released: 5, delivered: 1 }];
  assert.equal(taskStepPath(points, "delivered", 4), "M0,240h0.01H500V180H1000V180");
  assert.doesNotMatch(taskStepPath(points.slice(0, 1), "released", 4), /NaN|Infinity|H1000/);
});

test("task areas close at the X axis without creating an interval at step zero", () => {
  assert.equal(taskAreaPath([], "released", 4), "");
  for (const replay of gallery.cases) {
    assert.equal(taskAreaPath(taskHistory(replay, 0), "released", 4), "");
    for (const time of [1, 94, 1200, replay.frames.length - 1]) {
      const points = taskHistory(replay, time);
      const maximum = chartCeiling(points.at(-1).released);
      for (const key of ["released", "delivered"]) {
        const area = taskAreaPath(points, key, maximum);
        assert.equal(area, taskStepPath(points, key, maximum) + "L1000,240H0Z");
        assert.doesNotMatch(area, /NaN|Infinity/);
      }
    }
  }
});

test("fleet and vehicle tones follow recorded activity without changing vehicle identity", () => {
  const idle = { ...gallery.cases[0].frames[0].vehicles[0], action: "wait", status: "standby", carriedOrderId: null, assignedOrderId: null, deliveredOrderId: null, violations: [] };
  const working = { ...idle, action: "right", assignedOrderId: "order-001" };
  const charging = { ...idle, action: "charge" };
  const waiting = { ...working, action: "wait" };
  const complete = { ...idle, status: "complete" };
  const alert = { ...working, violations: ["collision"] };
  for (const [vehicle, tone] of [[idle,"idle"],[working,"working"],[charging,"charging"],[waiting,"waiting"],[complete,"complete"],[alert,"alert"], [{...working, carriedOrderId:"order-001"},"working"], [{...waiting,status:"yielding"},"waiting"]]) {
    assert.equal(vehicleStatusTone(vehicle), tone);
    assert.match(statusColors[tone], /^#[a-f0-9]{6}$/);
  }
  assert.equal(fleetStatusTone([idle, working]), "working");
  assert.equal(fleetStatusTone([charging, idle]), "charging");
  assert.equal(fleetStatusTone([charging, working]), "working");
  assert.equal(fleetStatusTone([waiting, working]), "waiting");
  assert.equal(fleetStatusTone([alert, waiting]), "alert");
  assert.equal(fleetStatusTone([complete, complete]), "complete");
  assert.equal(fleetStatusTone([complete, idle]), "idle");
  assert.equal(fleetStatusTone([]), "idle");
});

test("battery colors use capacity-relative levels, highlight charging and retain critical warnings", () => {
  const base = { ...gallery.cases[0].frames[0].vehicles[0], action: "wait", violations: [] };
  for (const [percent, expected] of [[0,"critical"],[20,"critical"],[21,"warning"],[40,"warning"],[41,"healthy"],[100,"healthy"]]) {
    for (const capacity of [100, 200]) {
      assert.equal(vehicleBatteryTone({ ...base, battery: percent * capacity / 100 }, capacity), expected);
    }
  }
  assert.equal(vehicleBatteryTone({ ...base, battery: 30, action: "charge" }, 100), "charging");
  assert.equal(vehicleBatteryTone({ ...base, battery: 20, action: "charge" }, 100), "critical");
  assert.equal(vehicleBatteryTone({ ...base, battery: 50, action: "charge", violations: ["not_at_charger"] }, 100), "healthy");
  assert.equal(vehicleBatteryTone({ ...base, battery: 30, status: "charging" }, 100), "warning", "The action, not a stale status, establishes charging");
  for (const item of gallery.cases) {
    for (const frame of item.frames) {
      assert.ok(statusColors[fleetStatusTone(frame.vehicles)]);
      for (const vehicle of frame.vehicles) {
        assert.ok(statusColors[vehicleStatusTone(vehicle)]);
        const tone = vehicleBatteryTone(vehicle, item.scenario.batteryCapacity);
        assert.ok(batteryColors[tone]);
        assert.ok(batteryToneHints[tone]);
      }
    }
  }
});

test("charger state distinguishes actual charging, parked vehicles and empty stations across all replays", () => {
  const seen = new Set();
  for (const { scenario, frames } of gallery.cases) {
    for (const frame of frames) {
      for (const station of scenario.chargingStations) {
        const result = chargingStationState(station, frame);
        const occupant = frame.vehicles.find(vehicle => vehicle.position[0] === station.x && vehicle.position[1] === station.y);
        assert.equal(result.vehicle, occupant ?? null);
        assert.equal(result.status, !occupant ? "unoccupied" : occupant.action === "charge" && !occupant.violations.length ? "charging" : "occupied");
        seen.add(result.status);
      }
    }
  }
  assert.deepEqual([...seen].sort(), ["charging", "occupied", "unoccupied"]);
  const frame = gallery.cases[0].frames[0];
  const robot = frame.vehicles[0];
  const station = { x: robot.position[0], y: robot.position[1] };
  for (const action of ["wait", "right", "pickup", "dropoff"]) {
    assert.equal(chargingStationState(station, { ...frame, vehicles: [{ ...robot, action, status: "charging" }] }).status, "occupied", "A stale status or simple occupancy is not a charging action");
  }
  assert.equal(chargingStationState(station, { ...frame, vehicles: [{ ...robot, action: "charge", violations: ["not_at_charger"] }] }).status, "occupied");
  assert.deepEqual(chargingStationState(station, { ...frame, vehicles: [] }), { vehicle: null, status: "unoccupied" });
});

test("terminology distinguishes discrete grid state from interpolated presentation", () => {
  assert.match(gridCellHint, /visually interpolated, not continuous-space simulation/);
  assert.match(simulationStepHint, /not elapsed seconds/);
  assert.equal(eventLabels.cell_blocked, "Cell blocked");
  assert.equal(eventLabels.cell_unblocked, "Cell reopened");
  assert.equal(orderLabels.ready, "Awaiting pickup");
  assert.equal(orderLabels.delivered, "Delivered");
});

test("vehicle labels describe actual action and cargo without inferring a charging or pickup destination", () => {
  const base = { ...gallery.cases[0].frames[0].vehicles[0], assignedOrderId: null, carriedOrderId: null };
  const assigned = { ...base, assignedOrderId: "order-001", action: "right", status: "collecting" };
  assert.equal(vehicleStatusLabel(assigned), "Assigned");
  assert.match(vehicleStatusHint(assigned), /may include a charging stop/);
  const loaded = { ...assigned, carriedOrderId: "order-001", status: "delivering" };
  assert.equal(vehicleStatusLabel(loaded), "In transit");
  assert.equal(vehicleStatusLabel({ ...loaded, action: "wait" }), "Waiting");
  assert.equal(vehicleStatusLabel({ ...loaded, action: "charge", status: "charging" }), "Charging");
  assert.equal(vehicleStatusLabel({ ...loaded, action: "wait", status: "yielding" }), "Yielding");
  assert.equal(vehicleStatusLabel({ ...base, action: "right", status: "returning" }), "Repositioning");
  assert.equal(vehicleStatusLabel(base), "Idle");
  assert.equal(vehicleStatusLabel({ ...base, status: "complete" }), "Finished");
  for (const { frames } of gallery.cases) {
    for (const frame of frames) {
      for (const vehicle of frame.vehicles) {
        if (vehicle.action === "pickup" && vehicle.carriedOrderId) assert.equal(vehicleStatusLabel(vehicle), "Loaded");
        if (vehicle.deliveredOrderId) assert.equal(vehicleStatusLabel(vehicle), "Delivered");
        assert.ok(vehicleStatusHint(vehicle), "Every displayed status has a precise explanation");
      }
    }
  }
});

test("cargo stays attached from pickup until successful dropoff for every task", () => {
  for (const { vehicles, frames } of gallery.cases) {
    const loads = new Map(vehicles.map(vehicle => [vehicle.id, null]));
    let pickups = 0, deliveries = 0, emptyAssignments = 0;
    for (const frame of frames) {
      for (const vehicle of frame.vehicles) {
        if (vehicle.action === "pickup" && !vehicle.violations.length) {
          assert.equal(loads.get(vehicle.id), null, "Loading starts on an empty forklift");
          assert.ok(vehicle.carriedOrderId);
          loads.set(vehicle.id, vehicle.carriedOrderId);
          pickups++;
        }
        if (vehicle.deliveredOrderId) {
          assert.equal(vehicle.action, "dropoff");
          assert.equal(loads.get(vehicle.id), vehicle.deliveredOrderId);
          loads.set(vehicle.id, null);
          deliveries++;
        }
        assert.equal(vehicle.carriedOrderId, loads.get(vehicle.id), "No cargo changes between loading and unloading");
        assert.equal(isVehicleLoaded(vehicle), loads.get(vehicle.id) !== null);
        if (vehicle.assignedOrderId && loads.get(vehicle.id) === null) {
          assert.equal(isVehicleLoaded(vehicle), false, "Travel to the pickup location is empty");
          emptyAssignments++;
        }
      }
    }
    assert.equal(pickups, 225);
    assert.equal(deliveries, 225);
    assert.ok(emptyAssignments > 0);
    assert.ok([...loads.values()].every(value => value === null));
    // Load visibility is derived from the current frame, including arbitrary rewind.
    const loaded = frames.find(frame => frame.vehicles.some(isVehicleLoaded));
    for (const frame of [loaded, frames.at(-1), loaded, frames[0]]) {
      for (const vehicle of frame.vehicles) assert.equal(isVehicleLoaded(vehicle), Boolean(vehicle.carriedOrderId));
    }
  }
});

test("cargo visibility depends on the carried order, not the task assignment or action label", () => {
  for (const action of ["pickup", "dropoff", "up", "wait", "charge"]) {
    for (const status of ["collecting", "delivering", "yielding", "charging", "standby"]) {
      assert.equal(isVehicleLoaded({ carriedOrderId: null, assignedOrderId: "order-001", action, status }), false);
      assert.equal(isVehicleLoaded({ carriedOrderId: "order-001", assignedOrderId: null, action, status }), true);
    }
  }
});

test("loaded cargo is visible above the chassis and supported by the forks within one cell", () => {
  const geometries = [], materials = [];
  const payload = buildForkliftPayload({
    geometry: value => { geometries.push(value); return value; },
    material: value => { materials.push(value); return value; },
  });
  try {
    assert.equal(payload.visible, false, "A new forklift starts empty");
    assert.equal(payload.children.filter(child => child.name === "cargo-carton").length, 4);
    const lift = new THREE.Group();
    lift.position.y = LOADED_FORK_LIFT;
    lift.add(payload);
    const bounds = new THREE.Box3().setFromObject(lift);
    assert.ok(bounds.min.y > 0.49, "Cargo no longer intersects the low chassis");
    assert.ok(bounds.max.y > 1 && bounds.max.y < 1.2, "Stack is prominent but stays below the vehicle badge");
    assert.ok(Math.abs(bounds.min.y - (0.15 + 0.035 / 2 + LOADED_FORK_LIFT)) < 0.005, "Pallet rests on the raised forks");
    assert.ok(bounds.min.z > 0.21 + 0.065 / 2, "Cargo is in front of the mast, not intersecting it");
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const z of [bounds.min.z, bounds.max.z]) assert.ok(Math.hypot(x, z) < 0.5, "Rotating cargo stays within the reserved grid cell");
    }
  } finally {
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
  }
});

test("industrial forklift geometry stays within its reserved cell while turning", () => {
  const geometries = [], materials = [];
  const resources = { geometry: value => { geometries.push(value); return value; }, material: value => { materials.push(value); return value; } };
  const { chassis, lift, wheels, tint } = buildIndustrialForklift(resources, "#c9ee96");
  try {
    assert.equal(wheels.length, 4);
    assert.equal(tint.color.getHexString(), "c9ee96");
    for (const name of ["counterweight", "mast-upright", "fork-tine", "carriage-crossbar", "safety-beacon", "fleet-color-panel"]) assert.ok(chassis.getObjectByName(name), name);
    const point = new THREE.Vector3();
    for (const raised of [0, LOADED_FORK_LIFT]) {
      lift.position.y = raised;
      chassis.updateMatrixWorld(true);
      chassis.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const positions = object.geometry.getAttribute("position");
        for (let i = 0; i < positions.count; i++) {
          point.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld);
          assert.ok(Math.hypot(point.x, point.z) < 0.5, object.name + " stays inside the cell at every heading");
        }
      });
    }
  } finally {
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
  }
});

test("only active task endpoints appear; delivered tasks stay in history, not on the floor", () => {
  assert.equal(isOrderMarkerVisible("queued"), false);
  assert.equal(isOrderMarkerVisible(undefined), false);
  for (const state of ["ready", "carried"]) assert.equal(isOrderMarkerVisible(state), true);
  for (const state of ["delivered", "expired"]) assert.equal(isOrderMarkerVisible(state), false);
  for (const state of [undefined, "queued", "ready", "carried", "delivered", "expired"]) {
    assert.equal(isOrderEndpointVisible(state, 0), state === "ready");
    assert.equal(isOrderEndpointVisible(state, 1), state === "ready" || state === "carried");
  }
  for (const { scenario, frames } of gallery.cases) {
    assert.equal(releasedOrderEntries(scenario.orders, frames[0]).length, 4);
    assert.equal(releasedOrderEntries(scenario.orders, frames.at(-1)).length, 225);
    for (const order of scenario.orders) {
      const release = frames[order.releaseTime];
      assert.equal(release.orderStates[order.id], "available");
      assert.ok(releasedOrderEntries(scenario.orders, release).some(entry => entry.order.id === order.id));
      if (order.releaseTime > 0) {
        const before = frames[order.releaseTime - 1];
        assert.equal(before.orderStates[order.id], "pending");
        assert.ok(!releasedOrderEntries(scenario.orders, before).some(entry => entry.order.id === order.id));
        assert.equal(isOrderMarkerVisible(displayedOrderState(before.orderStates[order.id])), false);
      }
    }
    for (const frame of frames) {
      const released = releasedOrderEntries(scenario.orders, frame);
      const shownMarkers = scenario.orders.filter(order => isOrderMarkerVisible(displayedOrderState(frame.orderStates[order.id])));
      assert.equal(shownMarkers.length, released.filter(({ order }) => ["available", "picked_up"].includes(frame.orderStates[order.id])).length, "Map shows only unfinished tasks from the released queue");
      assert.ok(frame.completedOrders <= released.length);
      for (const vehicle of frame.vehicles) {
        for (const id of [vehicle.assignedOrderId, vehicle.carriedOrderId].filter(Boolean)) {
          assert.ok(released.some(entry => entry.order.id === id), "Only released tasks can be assigned or carried");
        }
      }
    }
    assert.equal(releasedOrderEntries(scenario.orders, frames[0]).length, 4, "Rewinding restores the initial queue");
    assert.equal(scenario.orders.filter(order => isOrderMarkerVisible(displayedOrderState(frames.at(-1).orderStates[order.id]))).length, 0, "No task marker remains after the run completes");
  }
});

test("factory fixtures preserve every obstacle without filling a traversable cell", () => {
  let machineCount = 0;
  for (const { scenario } of gallery.cases) {
    const fixtures = factoryFixtures(scenario);
    assert.deepEqual(fixtures.map(({ x, y }) => ({ x, y })), scenario.obstacles);
    assert.deepEqual(fixtures, factoryFixtures(scenario), "Dressing is deterministic");
    assert.ok(fixtures.some(({ kind }) => kind === "rack"));
    machineCount += fixtures.filter(({ kind }) => kind === "machine").length;
  }
  assert.ok(machineCount > 0, "The gallery retains equipment cabinets without requiring them in every layout");
});

test("safety paint outlines the rack island, never an internal shared edge", () => {
  const scenario = { width: 4, height: 4, obstacles: [{ x: 1, y: 1 }, { x: 2, y: 1 }] };
  const edges = safetyEdges(scenario);
  assert.equal(edges.length, 6);
  assert.equal(edges.filter(({ horizontal }) => horizontal).length, 4);
  assert.ok(!edges.some(({ center, horizontal }) => !horizontal && center.x > 1 && center.x < 2));
  assert.deepEqual(safetyEdges({ ...scenario, obstacles: [] }), []);
});

test("double rack rows keep matching fixtures in every pair and cabinets only at the ends", () => {
  for (const horizontal of [false, true]) {
    const obstacles = Array.from({ length: 38 }, (_, index) => ({
      x: horizontal ? 2 + Math.floor(index / 2) : 15 + index % 2,
      y: horizontal ? 15 + index % 2 : 2 + Math.floor(index / 2),
    }));
    const scenario = { width: 32, height: 24, obstacles };
    const fixtures = factoryFixtures(scenario);
    for (let index = 0; index < fixtures.length; index += 2) {
      assert.equal(fixtures[index].kind, fixtures[index + 1].kind, "Each pair has two racks or two cabinets");
      if (index > 0 && index < fixtures.length - 2) assert.equal(fixtures[index].kind, "rack");
    }
    const byPosition = (a, b) => a.x - b.x || a.y - b.y;
    assert.deepEqual(
      factoryFixtures({ ...scenario, obstacles: [...obstacles].reverse() }).sort(byPosition),
      [...fixtures].sort(byPosition),
      "Pairing does not depend on obstacle ordering",
    );
  }
});

test("grid coordinates become centered x/z coordinates without changing simulator state", () => {
  assert.deepEqual(toWorld({ x: 0, y: 0 }, 16, 12), { x: -7.5, y: 0, z: -5.5 });
  assert.deepEqual(toWorld({ x: 15, y: 11 }, 16, 12, 0.5), { x: 7.5, y: 0.5, z: 5.5 });
  for (const { scenario, frames } of gallery.cases) {
    const points = [...scenario.obstacles, ...scenario.chargingStations, ...scenario.orders.flatMap(order => [order.pickup, order.dropoff]), ...frames.flatMap(frame => frame.vehicles.map(vehicle => ({ x: vehicle.position[0], y: vehicle.position[1] })))];
    for (const point of points) {
      const result = toWorld(point, scenario.width, scenario.height);
      assert.ok(Math.abs(result.x) < scenario.width / 2);
      assert.ok(Math.abs(result.z) < scenario.height / 2);
      assert.deepEqual({ x: result.x + (scenario.width - 1) / 2, y: result.z + (scenario.height - 1) / 2 }, point);
    }
  }
});

test("current task routes use only this assignment's history and the recorded plan", () => {
  const vehicle = (x, id, moves, carrying = false) => ({ position: [x, 1], assignedOrderId: id, carriedOrderId: carrying ? id : null, plannedMoves: moves });
  const replay = { frames: [
    { vehicles: [vehicle(0, "old", "RR")], orderStates: { old: "available", task: "pending" } },
    { vehicles: [vehicle(1, "task", "RR.")], orderStates: { old: "delivered", task: "available" } },
    { vehicles: [vehicle(2, "task", "D.R", true)], orderStates: { old: "delivered", task: "picked_up" } },
    { vehicles: [vehicle(2, null, "")], orderStates: { old: "delivered", task: "delivered" } },
  ] };
  const route = currentTaskRoute(replay, 2, 0);
  assert.equal(route.orderId, "task");
  assert.deepEqual(route.completed, [{x:1,y:1},{x:2,y:1}]);
  assert.deepEqual(route.planned, [{x:2,y:1},{x:2,y:2},{x:2,y:2},{x:3,y:2}]);
  assert.equal(currentTaskRoute(replay, 3, 0), null);
  assert.equal(currentTaskRoute(replay, 1, 8), null);
  assert.deepEqual(currentTaskRoute(replay, 1, 0).completed, [{x:1,y:1}]);
  assert.equal(currentTaskRoute(replay, 0, 0).orderId, "old", "Rewinding restores the old task");
  const prefix = { frames: replay.frames.slice(0, 3) };
  assert.deepEqual(currentTaskRoute(prefix, 2, 0), route, "Future frames never determine a plan");
  assert.throws(() => decodePlannedRoute({x:0,y:0}, "RX"), /Invalid/);
});

test("remaining route dashes stay anchored while the solid boundary advances", () => {
  const edge = { from: {x:0,y:0}, to: {x:1,y:0} };
  assert.equal(dashedRouteSegments([edge]).length, 3);
  const clipped = dashedRouteSegments([edge], 0.4);
  assert.equal(clipped.length, 2);
  assert.equal(clipped[0].from.x, 0.4);
  assert.deepEqual(clipped[1], dashedRouteSegments([edge])[2]);
  assert.deepEqual(dashedRouteSegments([edge], 1), []);
  assert.deepEqual(dashedRouteSegments([]), []);
  for (const segment of clipped) assert.ok(segment.from.x >= 0.4 && segment.to.x > segment.from.x && segment.to.x <= 1);
});

test("routes skip waits and discontinuities, and deduplicate repeated edges", () => {
  const a = { x: 1, y: 1 }, b = { x: 2, y: 1 }, c = { x: 5, y: 5 }, d = { x: 5, y: 6 };
  assert.deepEqual(routeSegments([a, a, b, a, c, d]), [{ from: a, to: b }, { from: c, to: d }]);
  assert.deepEqual(routeSegments([]), []);
  assert.equal(isAdjacent(a, { x: 2, y: 2 }), false);
});

test("solid-trail capacity covers every grid edge and cell without dashed buffers", () => {
  for (const [width, height] of [[1, 1], [1, 5], [7, 1], [2, 3], [32, 24]]) {
    const points = [];
    // Visit both directions of every horizontal and vertical edge.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const from = { x, y };
      if (x + 1 < width) points.push(from, { x: x + 1, y }, from);
      if (y + 1 < height) points.push(from, { x, y: y + 1 }, from);
    }
    const segments = routeSegments(points);
    const capacity = routeCapacity(width, height);
    assert.equal(segments.length, capacity.segments);
    assert.equal(capacity.joints, width * height);
  }
});

test("all recorded routes fit the instance buffer and only join adjacent cells", () => {
  for (const { scenario, vehicles, frames } of gallery.cases) {
    for (const vehicle of vehicles) {
      const points = frames.map(frame => frame.vehicles.find(item => item.id === vehicle.id)).map(item => ({ x: item.position[0], y: item.position[1] }));
      const segments = routeSegments(points);
      assert.ok(segments.every(({ from, to }) => isAdjacent(from, to)));
      const capacity = routeCapacity(scenario.width, scenario.height);
      assert.ok(segments.length <= capacity.segments);
      const joints = new Set(segments.flatMap(({ from, to }) => [`${from.x}:${from.y}`, `${to.x}:${to.y}`]));
      assert.ok(joints.size <= capacity.joints, "Rounded joints fit their instance buffer");
    }
  }
});

test("fleet animation follows stable vehicle IDs, not the inspector selection", () => {
  const robot = { id: "forklift-01", position: { x: 1, y: 1 }, color: "#007aff", complete: false };
  const other = { ...robot, id: "forklift-02", position: { x: 5, y: 1 } };
  const moved = { ...robot, position: { x: 2, y: 1 } };
  const previous = { time: 3, animate: true, primary: robot, fleet: [robot, other] };
  const next = { ...previous, time: 4, primary: other, fleet: [moved, other] };
  assert.equal(shouldAnimateFleetMove(previous, next, robot.id), true);
  assert.equal(shouldAnimateFleetMove(previous, next, other.id), false);
  assert.equal(shouldAnimateFleetMove(null, next, robot.id), false);
  for (const frame of [{ ...next, animate: false }, { ...next, time: 10 }, { ...next, time: 2 }, { ...next, fleet: [other] }, { ...next, fleet: [{ ...robot, position: { x: 9, y: 1 } }] }]) {
    assert.equal(shouldAnimateFleetMove(previous, frame, robot.id), false);
  }
});

test("forklifts move throughout the entire replay step at all playback speeds", () => {
  const from = { x: 2, y: 3 }, to = { x: 3, y: 3 };
  for (const duration of [520, 260, 130]) {
    const motion = createRobotMotion(from, to, Math.PI / 2, 1000, duration);
    for (const progress of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const sample = sampleRobotMotion(motion, 1000 + duration * progress);
      assert.ok(Math.abs(sample.position.x - (2 + progress)) < 1e-12);
      assert.equal(sample.position.y, 3);
      assert.equal(sample.heading, Math.PI / 2);
      assert.equal(sample.complete, progress === 1, "No early arrival or per-cell pause");
    }
    assert.deepEqual(sampleRobotMotion(motion, 900).position, from);
    assert.deepEqual(sampleRobotMotion(motion, 5000).position, to, "Late or background frames do not overshoot");
  }
});

test("turns follow the shortest arc while positions stay on recorded grid edges", () => {
  const incoming = createRobotMotion({ x: 1, y: 1 }, { x: 2, y: 1 }, Math.PI / 2, 0, 260);
  const corner = sampleRobotMotion(incoming, 260);
  const outgoing = createRobotMotion(corner.position, { x: 2, y: 2 }, corner.heading, 260, 260);
  assert.deepEqual(sampleRobotMotion(outgoing, 260).position, corner.position);
  assert.equal(sampleRobotMotion(outgoing, 260).heading, corner.heading);
  const midpoint = sampleRobotMotion(outgoing, 338);
  assert.ok(midpoint.heading > 0 && midpoint.heading < Math.PI / 2);
  assert.equal(midpoint.position.x, 2, "Turning never cuts diagonally into a rack");
  assert.equal(sampleRobotMotion(outgoing, 520).heading, 0);
  const wrapped = createRobotMotion({ x: 0, y: 1 }, { x: 0, y: 0 }, -Math.PI + 0.1, 0, 260);
  assert.ok(Math.abs(wrapped.turn + 0.1) < 1e-12, "Heading does not spin 360 degrees across the angle boundary");
});

test("pausing and changing speed preserve the current presentation pose", () => {
  const motion = createRobotMotion({ x: 2, y: 1 }, { x: 2, y: 2 }, Math.PI / 2, 100, 520);
  const now = 280;
  const before = sampleRobotMotion(motion, now);
  for (const remaining of [120, 130, 260, 520]) {
    const retimed = retimeRobotMotion(motion, now, remaining);
    const after = sampleRobotMotion(retimed, now);
    assert.ok(Math.abs(after.position.y - before.position.y) < 1e-12);
    assert.ok(Math.abs(after.heading - before.heading) < 1e-12);
    const finished = sampleRobotMotion(retimed, now + remaining + 0.001);
    assert.deepEqual(finished.position, motion.to);
    assert.equal(finished.complete, true);
  }
});

test("a growing trail only reveals its newest unvisited edge", () => {
  const a = { x: 1, y: 1 }, b = { x: 2, y: 1 }, c = { x: 2, y: 2 }, d = { x: 8, y: 8 };
  const points = [a, b, c];
  assert.deepEqual(progressiveRoute(points, true), { segments: [{ from: a, to: b }], tip: { from: b, to: c } });
  assert.deepEqual(progressiveRoute(points, false), { segments: routeSegments(points), tip: null });
  assert.deepEqual(progressiveRoute([a, b, a], true), { segments: [{ from: a, to: b }], tip: null }, "Retracing an existing edge does not add a duplicate glowing line");
  for (const path of [[], [a], [a, a], [a, b, b], [a, b, d]]) {
    assert.deepEqual(progressiveRoute(path, true), { segments: routeSegments(path), tip: null });
  }
  const motion = createRobotMotion(b, c, Math.PI / 2, 0, 260);
  const sample = sampleRobotMotion(motion, 130);
  assert.deepEqual(sample.position, { x: 2, y: 1.5 }, "Live trail ends at the interpolated forklift, not the next grid cell");
  assert.deepEqual(points, [a, b, c], "Presentation does not alter the recorded route");
});

test("interpolation stays on every recorded edge for all four fleets", () => {
  for (const { frames } of gallery.cases) {
    for (let time = 1; time < frames.length; time++) {
      for (let index = 0; index < frames[time].vehicles.length; index++) {
        const [x0, y0] = frames[time - 1].vehicles[index].position;
        const [x1, y1] = frames[time].vehicles[index].position;
        if (x0 === x1 && y0 === y1) continue;
        const motion = createRobotMotion({ x: x0, y: y0 }, { x: x1, y: y1 }, 0, 0, 260);
        for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
          const { position } = sampleRobotMotion(motion, progress * 260);
          assert.equal(x0 === x1 ? position.x : position.y, x0 === x1 ? x0 : y0);
          assert.ok(position.x >= Math.min(x0, x1) && position.x <= Math.max(x0, x1));
          assert.ok(position.y >= Math.min(y0, y1) && position.y <= Math.max(y0, y1));
        }
      }
    }
  }
});

test("fleet gallery rejects missing maps, corrupt coordinates, collisions and duplicate carrying", () => {
  for (const change of [
    data => { data.schemaVersion = 99; },
    data => { data.defaultCaseId = "missing"; },
    data => { data.cases[1].caseId = data.cases[0].caseId; },
    data => { data.cases[0].frames[0].vehicles[0].position = [-1, 0]; },
    data => { data.cases[0].frames[0].vehicles[0].battery = -1; },
    data => { data.cases[0].frames[0].vehicles[0].plannedMoves = "X"; },
    data => { data.cases[0].frames[0].vehicles[0].plannedMoves = 42; },
    data => { data.cases[0].frames[0].vehicles[0].plannedMoves = "L".repeat(data.cases[0].scenario.width); },
    data => { data.cases[0].frames[0].vehicles[1].position = data.cases[0].frames[0].vehicles[0].position; },
    data => { const frame = data.cases[0].frames.find(f => f.vehicles.some(v => v.carriedOrderId)); const carrier = frame.vehicles.find(v => v.carriedOrderId); frame.vehicles.find(v => v.id !== carrier.id).carriedOrderId = carrier.carriedOrderId; },
  ]) {
    const altered = structuredClone(gallery);
    change(altered);
    assert.throws(() => parseFleetGallery(altered));
  }
  assert.deepEqual(["pending", "available", "picked_up", "delivered", "expired"].map(displayedOrderState), ["queued", "ready", "carried", "delivered", "expired"]);
});
