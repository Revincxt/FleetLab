import * as THREE from "three";
import type { WorkerPose } from "./workforce-model";

type Resources = {
  geometry: <T extends THREE.BufferGeometry>(value: T) => T;
  material: <T extends THREE.Material>(value: T) => T;
};
export type WorkerVisual = {
  group: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  arms: THREE.Group[];
  legs: THREE.Group[];
};

/** Small shared meshes; no downloaded models, textures, skeletons, or render loop. */
export function workerFactory(resources: Resources) {
  const box = resources.geometry(new THREE.BoxGeometry(1, 1, 1));
  const sphere = resources.geometry(new THREE.SphereGeometry(1, 10, 8));
  const helmet = resources.geometry(new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2));
  const brim = resources.geometry(new THREE.CylinderGeometry(1, 1, 1, 12));
  const finish = (color: number) => resources.material(new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
  const navy = finish(0x354d63), boots = finish(0x26343b), skin = [finish(0xc79776), finish(0x956547), finish(0xe0b48d)];
  const vests = [finish(0xe7af58), finish(0xc5d891)], reflective = finish(0xe1e9dc), yellow = finish(0xf5d37a);
  const screen = finish(0x92c4ca);
  function part(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, size: number[], position: number[]) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.set(size[0], size[1], size[2]);
    mesh.position.set(position[0], position[1], position[2]);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }
  return (index: number): WorkerVisual => {
    const group = new THREE.Group(), body = new THREE.Group(), head = new THREE.Group();
    group.name = `worker-${index + 1}`;
    group.add(body);
    part(body, box, navy, [0.22, 0.30, 0.14], [0, 0.63, 0]);
    part(body, box, vests[index % 2], [0.235, 0.25, 0.155], [0, 0.65, 0]);
    part(body, box, reflective, [0.24, 0.024, 0.16], [0, 0.59, 0]);
    for (const x of [-0.065, 0.065]) part(body, box, reflective, [0.024, 0.23, 0.162], [x, 0.655, 0]);
    head.position.y = 0.86;
    body.add(head);
    part(head, sphere, skin[index % 3], [0.078, 0.10, 0.074], [0, 0, 0]);
    part(head, helmet, yellow, [0.095, 0.085, 0.09], [0, 0.053, 0]);
    part(head, brim, yellow, [0.109, 0.018, 0.105], [0, 0.052, 0.013]);
    const legs = [-1, 1].map(side => {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.065, 0.49, 0);
      body.add(pivot);
      part(pivot, box, navy, [0.085, 0.38, 0.10], [0, -0.185, 0]);
      part(pivot, box, boots, [0.09, 0.085, 0.15], [0, -0.44, 0.023]);
      return pivot;
    });
    const arms = [-1, 1].map(side => {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.145, 0.75, 0);
      body.add(pivot);
      part(pivot, box, navy, [0.065, 0.25, 0.075], [0, -0.105, 0]);
      part(pivot, sphere, skin[index % 3], [0.037, 0.047, 0.037], [0, -0.252, 0]);
      return pivot;
    });
    const tablet = part(arms[0], box, boots, [0.13, 0.018, 0.19], [0, -0.26, 0.055]);
    part(tablet, box, screen, [0.82, 1.05, 0.80], [0, 0.03, 0]);
    return { group, body, head, arms, legs };
  };
}

export function poseWorker(visual: WorkerVisual, pose: WorkerPose) {
  const walking = pose.activity === "walking", working = pose.inspection ?? Number(pose.activity === "working");
  const stride = walking ? Math.sin(pose.gait) * 0.44 : 0;
  visual.group.rotation.y = pose.heading;
  visual.body.position.y = walking ? Math.abs(Math.sin(pose.gait)) * 0.012 : 0;
  visual.body.rotation.x = working * 0.045;
  visual.legs[0].rotation.x = stride;
  visual.legs[1].rotation.x = -stride;
  visual.arms[0].rotation.x = -0.85 + (walking ? stride * 0.12 : 0);
  visual.arms[1].rotation.x = (-0.95 + Math.sin(pose.work) * 0.07) * working - stride * 0.7 * (1 - working);
  visual.arms[1].rotation.z = working * 0.22;
  visual.head.rotation.x = (0.2 + Math.sin(pose.work) * 0.025) * working;
}
