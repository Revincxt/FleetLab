import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { buildIndustrialForklift } from "../app/components/factory-forklift.ts";
import { buildForkliftPayload } from "../app/components/forklift-payload.ts";
import { poseWorker, workerFactory } from "../app/components/factory-workers.ts";
import { freezeMeshTransforms } from "../app/components/scene-transforms.ts";

test("fixed mesh transforms preserve moving vehicles, cargo, worker limbs, and sprites", () => {
  const resources = { geometry: value => value, material: value => value };
  function model() {
    const root = new THREE.Group();
    const robot = buildIndustrialForklift(resources, "#a2c7b4");
    const cargo = buildForkliftPayload(resources);
    robot.lift.add(cargo);
    const worker = workerFactory(resources)(0);
    const badge = new THREE.Sprite();
    root.add(robot.chassis, worker.group, badge);
    return { root, robot, cargo, worker, badge };
  }
  const reference = model(), optimized = model();
  freezeMeshTransforms(optimized.root);
  const matrices = root => {
    const values = [];
    root.traverse(object => values.push([...object.matrixWorld.elements]));
    return values;
  };
  let referenceUpdates = 0, optimizedUpdates = 0;
  for (const [scene, count] of [[reference, () => referenceUpdates++], [optimized, () => optimizedUpdates++]]) {
    scene.root.traverse(object => {
      const update = object.updateMatrix;
      object.updateMatrix = function () { count(); return update.call(this); };
    });
  }
  for (const [step, activity] of ["walking", "working", "waiting", "walking"].entries()) {
    for (const scene of [reference, optimized]) {
      scene.root.position.set(step, 0, -step);
      scene.robot.chassis.rotation.y = step * 0.4;
      scene.robot.lift.position.y = step * 0.12;
      scene.robot.wheels.forEach(wheel => { wheel.rotation.x = step * 0.3; });
      scene.cargo.visible = step % 2 === 0;
      scene.badge.scale.setScalar(1 + step * 0.1);
      poseWorker(scene.worker, { activity, heading: step, gait: step * 0.7, work: step * 0.5 });
      scene.root.updateMatrixWorld(true);
    }
    assert.deepEqual(matrices(optimized.root), matrices(reference.root));
    assert.equal(optimized.cargo.visible, reference.cargo.visible);
  }
  assert.ok(optimizedUpdates < referenceUpdates / 2, "Most local matrix compositions are eliminated");
  for (const scene of [reference, optimized]) {
    scene.root.traverse(object => {
      object.geometry?.dispose();
      object.material?.dispose();
    });
  }
});
