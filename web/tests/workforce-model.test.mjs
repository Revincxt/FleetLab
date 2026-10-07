import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import { buildWorkerTracks, interpolateWorker, workerPosition } from "../app/components/workforce-model.ts";
import { poseWorker, workerFactory } from "../app/components/factory-workers.ts";
import { parseFleetReplay } from "../app/components/fleet-model.ts";

const point = ([x, y]) => ({ x, y });
const key = ({ x, y }) => x + ":" + y;
// Check simultaneous linear interpolation, not just endpoint occupancy.
function sweptSeparation(a, b, c, d) {
  const x = a.x - c.x, y = a.y - c.y;
  const vx = b.x - a.x - d.x + c.x, vy = b.y - a.y - d.y + c.y;
  const speed2 = vx * vx + vy * vy;
  const t = speed2 ? Math.max(0, Math.min(1, -(x * vx + y * vy) / speed2)) : 0;
  return Math.hypot(x + vx * t, y + vy * t);
}

test("all twelve tapes contain three cell-occupying workers, random stops and collision-free motion", async () => {
  for (const name of ["fleet-demo", "fleet-whca", "fleet-rhcr-pbs"]) {
    const gallery = JSON.parse(await readFile(new URL("../public/" + name + ".json", import.meta.url), "utf8"));
    for (const replay of gallery.cases) {
      assert.equal(replay.workforce.moveSteps, 3);
      const tracks = buildWorkerTracks(replay.frames, replay.workforce.moveSteps);
      assert.equal(tracks.length, 3, name + "/" + replay.caseId);
      const obstacles = new Set([...replay.scenario.obstacles, ...replay.scenario.chargingStations].map(key));
      for (const [index, track] of tracks.entries()) {
        assert.equal(track.frames.length, replay.frames.length);
        assert.ok(track.frames.some(pose => pose.activity === "walking"));
        assert.ok(track.frames.some(pose => pose.activity === "working"));
        assert.ok(new Set(track.frames.map(pose => key(pose.position))).size > 20);
        for (const [time, pose] of track.frames.entries()) {
          const record = replay.frames[time].workers[index];
          assert.deepEqual(pose.position, workerPosition(record, 3), "Renderer follows recorded crossing progress");
          assert.equal(pose.activity, record.activity);
          assert.ok(record.position.every(Number.isInteger), "Logical occupancy stays discrete");
          assert.ok(!obstacles.has(key(point(record.position))));
          if (record.transit) assert.ok(!obstacles.has(key(point(record.transit))));
        }
      }
      for (let time = 1; time < replay.frames.length; time++) {
        const before = replay.frames[time - 1], after = replay.frames[time];
        const occupied = [...after.workers, ...after.vehicles].map(item => key(point(item.position)));
        assert.equal(new Set(occupied).size, 7);
        for (const [i, track] of tracks.entries()) {
          const a = track.frames[time - 1].position, b = track.frames[time].position;
          const distance = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
          assert.ok(distance < 1e-8 || Math.abs(distance - 1 / 3) < 1e-8, "Exactly one third cell per moving step");
          const record = after.workers[i];
          if (record.transit && !before.workers[i].transit) assert.ok(!before.blocked.some(p => key(p) === key(point(record.transit))));
          for (const [vehicle, old] of before.vehicles.entries()) {
            assert.ok(sweptSeparation(a, b, point(old.position), point(after.vehicles[vehicle].position)) >= 1 - 1e-8,
              name + "/" + replay.caseId + "/" + track.id + "/" + time + ": forklift swept motion overlaps a worker");
          }
          for (const other of tracks.slice(i + 1)) {
            assert.ok(sweptSeparation(a, b, other.frames[time - 1].position, other.frames[time].position) >= 1 - 1e-8);
          }
        }
      }
    }
  }
});

test("renderer derives deterministic poses only from recorded workers and never invents extra people", () => {
  const traffic = [
    { workers: [{ id: "worker-01", position: [2, 2], activity: "waiting" }] },
    { workers: [{ id: "worker-01", position: [3, 2], activity: "walking" }] },
    { workers: [{ id: "worker-01", position: [3, 2], activity: "working" }] },
  ];
  const original = JSON.stringify(traffic);
  const tracks = buildWorkerTracks(traffic);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].frames[1].heading, Math.PI / 2);
  assert.equal(tracks[0].frames[1].gait, tracks[0].frames[2].gait);
  assert.equal(JSON.stringify(traffic), original);
  assert.deepEqual(buildWorkerTracks(traffic), tracks, "Seeking and rebuilding reproduce the same pose");
  assert.deepEqual(buildWorkerTracks([{ vehicles: [], blocked: [] }]), []);
  assert.throws(() => buildWorkerTracks([traffic[0], { workers: [] }]), /inconsistent/);
});

test("replay validation rejects corrupt people, overlaps, jumps and reverse-edge movement", async () => {
  const raw = JSON.parse(await readFile(new URL("../public/fleet-demo.json", import.meta.url), "utf8")).cases[0];
  const replay = parseFleetReplay(raw);
  assert.equal(replay.workforce.count, 3);
  for (const corrupt of [
    frame => { frame.workers.pop(); },
    frame => { frame.workers[0].id = frame.vehicles[0].id; },
    frame => { frame.workers[0].position = [...frame.vehicles[0].position]; },
    frame => { frame.workers[0].position = [...frame.workers[1].position]; },
    frame => { frame.workers[0].position[0] += 0.5; },
    frame => { frame.workers[0].position[0] = -1; },
    frame => { frame.workers[0].activity = "teleporting"; },
    frame => { frame.workers[0].transit[2] = 3; },
    frame => { frame.workers[0].transit[2] = 2; },
    frame => { frame.workers[0].transit = [0, 0, 1]; },
    frame => { frame.workers[0].position = [...replay.frames[0].vehicles[0].position]; },
    frame => { frame.workers[0].position = [...replay.frames[0].workers[1].position]; },
    frame => { frame.vehicles[0].position = [...replay.frames[0].workers[0].position]; },
  ]) {
    const frames = [...replay.frames], frame = structuredClone(frames[1]);
    corrupt(frame); frames[1] = frame;
    assert.throws(() => parseFleetReplay({ ...replay, frames }), /invalid/);
  }
  assert.throws(() => parseFleetReplay({ ...replay, workforce: { count: 6, seed: 17 } }), /invalid/);
  assert.throws(() => parseFleetReplay({ ...replay, frames: [{ ...replay.frames[0], workers: {} }, ...replay.frames.slice(1)] }), /invalid/);
});

test("a walking cell spans three replay frames with continuous one-third-speed interpolation", () => {
  const frame = (position, transit) => ({ workers: [{ id: "worker", position, activity: transit || position[0] === 3 ? "walking" : "waiting", ...(transit ? { transit } : {}) }] });
  const frames = [frame([2, 2]), frame([2, 2], [3, 2, 1]), frame([2, 2], [3, 2, 2]), frame([3, 2])];
  const [track] = buildWorkerTracks(frames, 3);
  for (let time = 0; time < 3; time++) {
    assert.ok(Math.abs(track.frames[time].position.x - (2 + time / 3)) < 1e-8);
    const half = interpolateWorker(track.frames[time], track.frames[time + 1], 0.5);
    assert.ok(Math.abs(half.position.x - (2 + (time + 0.5) / 3)) < 1e-8);
    assert.ok(Math.abs(track.frames[time + 1].gait - track.frames[time].gait - Math.PI) < 1e-8);
  }
  assert.equal(track.frames[3].position.x, 3);
  const retreat = buildWorkerTracks([frames[2], frames[1], frames[0]], 3)[0];
  assert.deepEqual(retreat.frames.map(pose => pose.position.x), [2 + 2 / 3, 2 + 1 / 3, 2]);
});

test("worker interpolation stays within the recorded edge and uses the shortest turn", () => {
  const from = { position: { x: 1, y: 2 }, heading: Math.PI - 0.1, gait: 1, work: 1, activity: "walking" };
  const to = { ...from, position: { x: 1, y: 3 }, heading: -Math.PI + 0.1, gait: 2, work: 2, activity: "working" };
  assert.deepEqual(interpolateWorker(from, to, 0).position, from.position);
  assert.deepEqual(interpolateWorker(from, to, 1).position, to.position);
  const half = interpolateWorker(from, to, 0.5);
  assert.deepEqual(half.position, { x: 1, y: 2.5 });
  assert.ok(Math.abs(half.heading - Math.PI) < 1e-8);
  assert.equal(half.gait, 1.5);
  assert.equal(half.inspection, 0.5);
  assert.equal(half.activity, "walking");
  assert.equal(interpolateWorker(from, to, 1).activity, "working");
});

test("three articulated workers share lightweight geometry and materials", () => {
  const geometries = new Set(), materials = new Set();
  const makeWorker = workerFactory({
    geometry: value => { geometries.add(value); return value; },
    material: value => { materials.add(value); return value; },
  });
  const visuals = Array.from({ length: 3 }, (_, i) => makeWorker(i));
  assert.equal(geometries.size, 4);
  assert.equal(materials.size, 10);
  for (const visual of visuals) {
    for (const activity of ["working", "walking", "waiting"]) {
      poseWorker(visual, { position: { x: 0, y: 0 }, heading: 0, gait: 1.1, work: 2.3, activity });
      const box = new THREE.Box3().setFromObject(visual.group);
      assert.ok(box.min.y > -0.02 && box.max.y < 1.1);
      assert.equal(visual.arms.length, 2);
      assert.equal(visual.legs.length, 2);
    }
  }
  geometries.forEach(value => value.dispose());
  materials.forEach(value => value.dispose());
});
