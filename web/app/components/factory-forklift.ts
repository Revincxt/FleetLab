import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

type Resources = {
  geometry: <T extends THREE.BufferGeometry>(value: T) => T;
  material: <T extends THREE.Material>(value: T) => T;
};

/** Counterbalanced driverless forklift. All hard parts stay within one cell. */
export function buildIndustrialForklift(resources: Resources, color: string) {
  const chassis = new THREE.Group(), lift = new THREE.Group();
  chassis.name = "industrial-forklift";
  lift.name = "fork-carriage";
  const finish = (color: THREE.ColorRepresentation, roughness = 0.6, metalness = 0.2) =>
    resources.material(new THREE.MeshStandardMaterial({ color, roughness, metalness }));
  const paint = finish(0xc9923e), steel = finish(0x3c464a, 0.43, 0.65);
  const rubber = finish(0x20262a, 0.96, 0), alloy = finish(0x909b9d, 0.38, 0.65);
  const tint = finish(color), dark = finish(0x283136);
  const light = resources.material(new THREE.MeshStandardMaterial({ color: 0xf0ead9, emissive: 0xe5dcbf, emissiveIntensity: 0.7 }));
  const amber = resources.material(new THREE.MeshStandardMaterial({ color: 0xe2ae46, emissive: 0xc77b20, emissiveIntensity: 0.35 }));
  const box = resources.geometry(new THREE.BoxGeometry(1, 1, 1));
  function part(parent: THREE.Group, material: THREE.Material, size: number[], position: number[], name?: string) {
    const mesh = new THREE.Mesh(box, material);
    mesh.scale.set(size[0], size[1], size[2]);
    mesh.position.set(position[0], position[1], position[2]);
    mesh.castShadow = mesh.receiveShadow = true;
    if (name) mesh.name = name;
    parent.add(mesh);
    return mesh;
  }
  function shell(material: THREE.Material, size: number[], position: number[], radius: number, name: string) {
    const mesh = new THREE.Mesh(resources.geometry(new RoundedBoxGeometry(size[0], size[1], size[2], 2, radius)), material);
    mesh.position.set(position[0], position[1], position[2]);
    mesh.name = name; mesh.castShadow = mesh.receiveShadow = true;
    chassis.add(mesh);
  }
  shell(rubber, [0.62, 0.10, 0.64], [0, 0.16, -0.03], 0.025, "impact-bumper");
  shell(paint, [0.57, 0.30, 0.28], [0, 0.33, -0.20], 0.035, "counterweight");
  shell(paint, [0.53, 0.18, 0.32], [0, 0.26, 0.05], 0.015, "drive-chassis");
  shell(dark, [0.39, 0.20, 0.30], [0, 0.56, -0.15], 0.012, "control-housing");
  part(chassis, tint, [0.395, 0.035, 0.24], [0, 0.64, -0.15], "fleet-color-panel");
  part(chassis, steel, [0.36, 0.045, 0.26], [0, 0.68, -0.15]);
  const lidar = new THREE.Mesh(resources.geometry(new THREE.CylinderGeometry(0.055, 0.065, 0.085, 12)), dark);
  lidar.position.set(0, 0.745, -0.19); chassis.add(lidar);
  part(chassis, amber, [0.055, 0.06, 0.055], [-0.14, 0.73, -0.16], "safety-beacon");
  for (const side of [-1, 1]) {
    part(chassis, tint, [0.012, 0.055, 0.21], [side * 0.287, 0.37, -0.20]);
    part(chassis, light, [0.085, 0.032, 0.018], [side * 0.20, 0.28, 0.215]);
    for (let i = 0; i < 4; i++) part(chassis, dark, [0.012, 0.018, 0.13], [side * 0.287, 0.24 + i * 0.025, -0.20]);
    part(chassis, steel, [0.055, 1.0, 0.065], [side * 0.19, 0.64, 0.21], "mast-upright");
    part(chassis, alloy, [0.012, 0.84, 0.055], [side * 0.1575, 0.64, 0.21], "lift-rail");
    part(lift, steel, [0.065, 0.035, 0.27], [side * 0.18, 0.15, 0.315], "fork-tine");
  }
  for (const y of [0.25, 1.1]) part(chassis, steel, [0.43, 0.05, 0.065], [0, y, 0.21]);
  part(lift, steel, [0.45, 0.055, 0.03], [0, 0.23, 0.244], "carriage-crossbar");
  for (const x of [-0.12, 0, 0.12]) part(lift, alloy, [0.018, 0.40, 0.025], [x, 0.43, 0.232]);
  const wheelGeometry = resources.geometry(new THREE.CylinderGeometry(0.105, 0.105, 0.075, 16));
  const hubGeometry = resources.geometry(new THREE.CylinderGeometry(0.05, 0.05, 0.078, 12));
  const wheels: THREE.Group[] = [];
  for (const x of [-0.30, 0.30]) for (const z of [-0.22, 0.16]) {
    const wheel = new THREE.Group(); wheel.name = "wheel"; wheel.position.set(x, 0.11, z);
    for (const [geometry, material] of [[wheelGeometry, rubber], [hubGeometry, alloy]] as const) {
      const mesh = new THREE.Mesh(geometry, material); mesh.rotation.z = Math.PI / 2;
      mesh.castShadow = true; wheel.add(mesh);
    }
    part(wheel, dark, [0.08, 0.012, 0.075], [0, 0, 0]);
    chassis.add(wheel); wheels.push(wheel);
  }
  chassis.add(lift);
  return { chassis, lift, wheels, tint };
}
