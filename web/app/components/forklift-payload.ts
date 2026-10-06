import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

type PayloadResources = {
  geometry: <T extends THREE.BufferGeometry>(value: T) => T;
  material: <T extends THREE.Material>(value: T) => T;
};

export const LOADED_FORK_LIFT = 0.34;

/** A visible pallet above the chassis, supported by the raised forks. */
export function buildForkliftPayload(resources: PayloadResources) {
  const payload = new THREE.Group();
  payload.name = "forklift-payload";
  payload.position.set(0, 0.17, 0.345);
  payload.visible = false;
  const wood = resources.material(new THREE.MeshStandardMaterial({ color: 0x826246, roughness: 0.95 }));
  const carton = resources.material(new THREE.MeshStandardMaterial({ color: 0xd8a668, roughness: 0.82 }));
  const tape = resources.material(new THREE.MeshStandardMaterial({ color: 0xf2d5a3, roughness: 0.72 }));
  const pallet = new THREE.Mesh(resources.geometry(new THREE.BoxGeometry(0.44, 0.06, 0.20)), wood);
  pallet.position.y = 0.03;
  payload.add(pallet);
  const cartonGeometry = resources.geometry(new RoundedBoxGeometry(0.20, 0.24, 0.19, 2, 0.008));
  const topTape = resources.geometry(new THREE.BoxGeometry(0.03, 0.003, 0.19));
  const frontTape = resources.geometry(new THREE.BoxGeometry(0.03, 0.24, 0.003));
  for (const x of [-0.105, 0.105]) {
    for (const level of [0, 1]) {
      const y = 0.185 + level * 0.245;
      const box = new THREE.Mesh(cartonGeometry, carton);
      box.name = "cargo-carton";
      box.position.set(x, y, 0);
      const top = new THREE.Mesh(topTape, tape);
      top.position.set(x, y + 0.12, 0);
      const front = new THREE.Mesh(frontTape, tape);
      front.position.set(x, y, 0.095);
      payload.add(box, top, front);
    }
  }
  payload.traverse((object) => {
    if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; }
  });
  return payload;
}
