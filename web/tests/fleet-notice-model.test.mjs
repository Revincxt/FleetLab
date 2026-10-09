import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fleetNoticesAt, FleetNoticeBoard, layoutNotices, NOTICE_DURATION, NOTICE_HEIGHT, NOTICE_WIDTH } from "../app/components/fleet-notice-model.ts";
import { parseFleetGallery } from "../app/components/fleet-model.ts";
import { fleetAlgorithms } from "../app/components/fleet-algorithms.ts";

const vehicle = (patch = {}) => ({ id: "agv-01", position: [0, 0], assignedOrderId: "a", carriedOrderId: null, deliveredOrderId: null, plannedMoves: "RRDD", ...patch });
const frame = (robot, orderStates = {}) => ({ vehicles: [robot], orderStates: { a: "available", b: "available", ...orderStates } });
const events = (before, after) => fleetNoticesAt({ frames: [before, after] }, 1);
const notice = (kind, step, vehicleId = "agv-01", orderId = "a") => ({ id: `${step}:${vehicleId}:${kind}:${orderId}`, kind, step, vehicleId, orderId });

test("normal progress, time-only waits and rolling-window extensions are not reroutes", () => {
  const before = frame(vehicle());
  for (const plannedMoves of ["RDD", "RDDLL", "R", ".R.D.D.", "", undefined]) {
    assert.deepEqual(events(before, frame(vehicle({ position: [1, 0], plannedMoves }))), []);
  }
  assert.deepEqual(events(frame(vehicle({ plannedMoves: ".RR.DD" })), frame(vehicle({ plannedMoves: "R.RD.D." }))), []);
  assert.deepEqual(events(frame(vehicle({ plannedMoves: undefined })), frame(vehicle({ plannedMoves: "DDRR" }))), []);
  assert.deepEqual(events(frame(vehicle({ plannedMoves: "R" })), frame(vehicle({ position: [1, 0], plannedMoves: "DLL" }))), [], "New horizon beyond an exhausted plan is not a known change");
});

test("a changed spatial route is detected, including after a stationary traffic wait", () => {
  assert.equal(events(frame(vehicle()), frame(vehicle({ position: [1, 0], plannedMoves: "DRD" })))[0].kind, "route");
  assert.equal(events(frame(vehicle()), frame(vehicle({ position: [0, 1], plannedMoves: "RRD" })))[0].kind, "route");
  const replay = { frames: [frame(vehicle()), frame(vehicle({ plannedMoves: "..." })), frame(vehicle({ plannedMoves: "" })), frame(vehicle({ plannedMoves: "DRRD" }))] };
  assert.deepEqual(fleetNoticesAt(replay, 2), []);
  assert.equal(fleetNoticesAt(replay, 3)[0].kind, "route");
  assert.deepEqual(fleetNoticesAt({ frames: replay.frames.slice(0, 3) }, 2), fleetNoticesAt(replay, 2), "No future route is consulted");
  assert.deepEqual(events(frame(vehicle()), frame(vehicle({ assignedOrderId: "b", plannedMoves: "DDRR" }))), [], "Assigning a new task is not rerouting the old task");
});

test("pickup and delivery messages require successful cargo transitions and outrank reroutes", () => {
  const loaded = frame(vehicle({ carriedOrderId: "a", plannedMoves: "DDRR" }), { a: "picked_up" });
  const pickedUp = events(frame(vehicle()), loaded);
  assert.deepEqual(pickedUp, [notice("pickup", 1)]);
  assert.deepEqual(events(loaded, loaded), [], "Carrying the same load never repeats pickup");
  const delivered = frame(vehicle({ assignedOrderId: "b", deliveredOrderId: "a" }), { a: "delivered" });
  assert.deepEqual(events(loaded, delivered), [notice("delivery", 1)]);
  assert.deepEqual(events(delivered, delivered), [], "Delivery metadata alone cannot repeat a delivery");
  assert.deepEqual(events(frame(vehicle()), frame(vehicle({ action: "wait", requestedAction: "pickup", violations: ["blocked"] }))), []);
  assert.deepEqual(events(loaded, frame(vehicle({ carriedOrderId: "a", requestedAction: "dropoff", plannedMoves: "DDRR" }), { a: "picked_up" })), []);
  assert.deepEqual(events(frame(vehicle()), frame(vehicle({ plannedMoves: "DDRR" }), { a: "expired" })), []);
  assert.deepEqual(fleetNoticesAt({ frames: [loaded] }, 0), []);
});

test("each vehicle can speak independently in the same simulation step", () => {
  const a = vehicle(), b = vehicle({ id: "agv-02", assignedOrderId: "b", carriedOrderId: "b" });
  const before = { vehicles: [a, b], orderStates: { a: "available", b: "picked_up" } };
  const after = { vehicles: [{ ...a, carriedOrderId: "a" }, { ...b, carriedOrderId: null, deliveredOrderId: "b" }], orderStates: { a: "picked_up", b: "delivered" } };
  assert.deepEqual(events(before, after).map(item => [item.vehicleId, item.kind]), [["agv-01", "pickup"], ["agv-02", "delivery"]]);
});

test("notice playback ignores selection updates, clears on seek, and can replay after rewind", () => {
  const board = new FleetNoticeBoard();
  board.step(0, [], 0);
  board.step(1, [notice("pickup", 1)], 100);
  const original = board.shown(100)[0];
  board.step(1, [notice("pickup", 1)], 900);
  assert.deepEqual(board.shown(900), [original], "Selecting or pausing does not restart the timer");
  assert.deepEqual(board.shown(100 + NOTICE_DURATION), [], "Paused scenes still expire notices");
  board.step(8, [notice("delivery", 8)], 3000);
  assert.deepEqual(board.shown(3000), [], "Seeking does not emit historical events");
  board.step(0, [], 3200);
  board.step(1, [notice("pickup", 1)], 3400);
  assert.equal(board.shown(3400)[0].notice.kind, "pickup");
  board.reset();
  assert.deepEqual(board.shown(3500), []);
  board.step(1, [notice("pickup", 1)], 3600);
  assert.deepEqual(board.shown(3600), [], "Opening another replay does not speak on its initial frame");
});

test("task milestones preempt reroutes, queue in order, and reroute chatter is throttled", () => {
  const board = new FleetNoticeBoard();
  board.step(0, [], 0);
  board.step(1, [notice("route", 1)], 100);
  board.step(2, [notice("route", 2)], 200);
  assert.equal(board.shown(200)[0].notice.step, 1);
  board.step(3, [notice("pickup", 3)], 300);
  assert.equal(board.shown(300)[0].notice.kind, "pickup");
  board.step(4, [notice("delivery", 4)], 500);
  assert.equal(board.shown(500)[0].notice.kind, "pickup", "A rapid delivery does not erase an unread pickup");
  assert.equal(board.shown(300 + NOTICE_DURATION)[0].notice.kind, "delivery");
  const queuedDeliveryTime = 400 + NOTICE_DURATION;
  board.step(5, [notice("pickup", 5, "agv-02")], queuedDeliveryTime);
  assert.equal(board.shown(queuedDeliveryTime).length, 2, "Queues belong to vehicles, not the selected inspector");
  assert.deepEqual(board.shown(20000), [], "Returning to a hidden tab does not replay a stale backlog");
});

test("nearby bubbles avoid overlap and stay inside the viewport", () => {
  for (const [width, height] of [[320, 360], [960, 800]]) {
    for (const [x, y] of [[160, 250], [0, 0], [width, height]]) {
      const anchors = Array.from({ length: 4 }, (_, index) => ({ vehicleId: String(index), label: String(index), color: "#abcdef", x, y }));
      const layout = layoutNotices(anchors, width, height);
      for (const [index, point] of layout.entries()) {
        assert.ok(point.bubbleX - NOTICE_WIDTH / 2 >= 0 && point.bubbleX + NOTICE_WIDTH / 2 <= width);
        assert.ok(point.bubbleY - NOTICE_HEIGHT >= 0 && point.bubbleY <= height);
        for (const other of layout.slice(0, index)) assert.ok(Math.abs(point.bubbleX - other.bubbleX) >= NOTICE_WIDTH || Math.abs(point.bubbleY - other.bubbleY) >= NOTICE_HEIGHT);
        assert.equal(point.x, x); assert.equal(point.y, y);
      }
    }
  }
});

test("all twelve recorded runs provide exactly one pickup and delivery notice per task", async () => {
  for (const algorithm of fleetAlgorithms) {
    const gallery = parseFleetGallery(JSON.parse(await readFile(new URL(`../public/${algorithm.file}`, import.meta.url), "utf8")));
    for (const replay of gallery.cases) {
      const counts = { route: 0, pickup: 0, delivery: 0 }, picked = new Set(), delivered = new Set();
      for (let time = 0; time < replay.frames.length; time++) {
        const notices = fleetNoticesAt(replay, time);
        assert.equal(new Set(notices.map(item => item.vehicleId)).size, notices.length);
        for (const item of notices) {
          counts[item.kind]++;
          if (item.kind === "pickup") { assert.ok(!picked.has(item.orderId)); picked.add(item.orderId); }
          if (item.kind === "delivery") { assert.ok(picked.has(item.orderId)); assert.ok(!delivered.has(item.orderId)); delivered.add(item.orderId); }
        }
      }
      assert.equal(counts.pickup, 225, `${algorithm.id}/${replay.caseId} pickups`);
      assert.equal(counts.delivery, 225, `${algorithm.id}/${replay.caseId} deliveries`);
      assert.ok(counts.route > 0, `${algorithm.id}/${replay.caseId} reroutes`);
    }
  }
});
