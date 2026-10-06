import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { factoryFixtures, safetyEdges } from "./factory-layout";
import { toWorld, type MazeScenario } from "./maze-model";

type Resources = {
  geometry: <T extends THREE.BufferGeometry>(value: T) => T;
  material: <T extends THREE.Material>(value: T) => T;
  texture: <T extends THREE.Texture>(value: T) => T;
};
type Batch = { geometry: THREE.BufferGeometry; material: THREE.Material; matrices: THREE.Matrix4[] };

/** Static industrial dressing, batched by material; nothing changes navigability. */
export function buildFactoryEnvironment(scene: THREE.Scene, scenario: MazeScenario, resources: Resources) {
  const { width, height } = scenario;
  const batches = new Map<string, Batch>();
  const boxGeometry = resources.geometry(new THREE.BoxGeometry(1, 1, 1));
  const transform = new THREE.Object3D();
  const metal = (color: number, roughness = 0.65, metalness = 0.2) => resources.material(new THREE.MeshStandardMaterial({ color, roughness, metalness }));
  const materials = {
    steel: metal(0x314e61, 0.48, 0.55),
    beam: metal(0x799196, 0.55, 0.35),
    shelf: metal(0x526c7a, 0.55, 0.4),
    wood: metal(0x777667, 0.95, 0),
    carton: metal(0x9b8f76, 0.98, 0),
    lightCarton: metal(0xb3a78f, 0.98, 0),
    tape: metal(0xd8c7a4, 0.9, 0),
    crate: metal(0x637c80, 0.8, 0.04),
    casing: metal(0x778f95, 0.56, 0.35),
    dark: metal(0x303b42, 0.65, 0.25),
    yellow: metal(0x86a89d, 0.8, 0),
    white: metal(0xa5bac1, 0.87, 0),
    wall: metal(0x445e6c, 0.9, 0.05),
    wallBase: metal(0x2d4554, 0.8, 0.12),
    red: metal(0xa95043, 0.7, 0.1),
    screen: resources.material(new THREE.MeshStandardMaterial({ color: 0x426879, emissive: 0x437f93, emissiveIntensity: 0.4, roughness: 0.4 })),
    light: resources.material(new THREE.MeshStandardMaterial({ color: 0xf4f1db, emissive: 0xfff5d6, emissiveIntensity: 1.5 })),
  };
  type Finish = keyof typeof materials;
  function part(finish: Finish, x: number, y: number, z: number, sx: number, sy: number, sz: number, rotation = 0) {
    let batch = batches.get(finish);
    if (!batch) {
      batch = { geometry: boxGeometry, material: materials[finish], matrices: [] };
      batches.set(finish, batch);
    }
    transform.position.set(x, y, z);
    transform.rotation.set(0, rotation, 0);
    transform.scale.set(sx, sy, sz);
    transform.updateMatrix();
    batch.matrices.push(transform.matrix.clone());
  }
  function texture(width: number, height: number, paint: (context: CanvasRenderingContext2D) => void) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Factory textures unavailable");
    paint(context);
    const map = resources.texture(new THREE.CanvasTexture(canvas));
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 4;
    return map;
  }
  function sign(text: string, x: number, y: number, z: number, size: number, floor = false) {
    const map = texture(512, 96, (ctx) => {
      ctx.fillStyle = floor ? "#e2dfd0" : "#344d5b";
      ctx.fillRect(0, 0, 512, 96);
      ctx.fillStyle = floor ? "#68716e" : "#edf1ed";
      ctx.font = '500 48px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 256, 50);
    });
    const material = resources.material(new THREE.MeshStandardMaterial({ map, roughness: 0.9, transparent: floor, opacity: floor ? 0.7 : 1 }));
    const mesh = new THREE.Mesh(resources.geometry(new THREE.PlaneGeometry(size, size * 96 / 512)), material);
    mesh.position.set(x, y, z);
    if (floor) mesh.rotation.x = -Math.PI / 2;
    scene.add(mesh);
  }

  scene.add(new THREE.HemisphereLight(0xcce8ff, 0x34434f, 1.5));
  const sun = new THREE.DirectionalLight(0xd7eeff, 2.4);
  sun.position.set(-7, 18, 9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const shadowExtent = Math.hypot(width, height) / 2 + 3;
  sun.shadow.camera.left = sun.shadow.camera.bottom = -shadowExtent;
  sun.shadow.camera.right = sun.shadow.camera.top = shadowExtent;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 60;
  sun.shadow.normalBias = 0.025;
  sun.shadow.bias = -0.0001;
  sun.shadow.radius = 2;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xe5edff, 0.65);
  fill.position.set(8, 9, -5);
  scene.add(fill);

  // Deterministic concrete grain: a small repeating texture, not a large asset.
  const concrete = texture(512, 512, (ctx) => {
    ctx.fillStyle = "#354c58";
    ctx.fillRect(0, 0, 512, 512);
    let seed = 617;
    for (let i = 0; i < 26000; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const x = seed % 512;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const y = seed % 512;
      ctx.fillStyle = i % 2 ? "#ffffff0b" : "#28363009";
      ctx.fillRect(x, y, 1 + i % 3, 1);
    }
  });
  concrete.wrapS = concrete.wrapT = THREE.RepeatWrapping;
  concrete.repeat.set(width / 4, height / 4);
  const floorMaterial = resources.material(new THREE.MeshStandardMaterial({ color: 0xffffff, map: concrete, roughness: 0.88, metalness: 0.02 }));
  const foundation = new THREE.Mesh(resources.geometry(new RoundedBoxGeometry(width + 1.5, 0.28, height + 1.5, 2, 0.06)), metal(0x253b49));
  foundation.position.y = -0.17;
  foundation.castShadow = foundation.receiveShadow = true;
  scene.add(foundation);
  const floor = new THREE.Mesh(resources.geometry(new THREE.PlaneGeometry(width + 1.4, height + 1.4)), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.015;
  floor.receiveShadow = true;
  scene.add(floor);
  const seams: THREE.Vector3[] = [];
  for (let x = -width / 2; x <= width / 2; x += 4) seams.push(new THREE.Vector3(x, -0.01, -height / 2 - 0.65), new THREE.Vector3(x, -0.01, height / 2 + 0.65));
  for (let z = -height / 2; z <= height / 2; z += 4) seams.push(new THREE.Vector3(-width / 2 - 0.65, -0.01, z), new THREE.Vector3(width / 2 + 0.65, -0.01, z));
  scene.add(new THREE.LineSegments(resources.geometry(new THREE.BufferGeometry().setFromPoints(seams)), resources.material(new THREE.LineBasicMaterial({ color: 0x747f7f, transparent: true, opacity: 0.35 }))));
  const shadowFloor = new THREE.Mesh(resources.geometry(new THREE.PlaneGeometry(width * 4, height * 4)), resources.material(new THREE.ShadowMaterial({ opacity: 0.19 })));
  shadowFloor.rotation.x = -Math.PI / 2;
  shadowFloor.position.y = -0.32;
  shadowFloor.receiveShadow = true;
  scene.add(shadowFloor);

  // A low, two-sided cutaway shell keeps the working floor visible when orbiting.
  const back = -height / 2 - 0.48, left = -width / 2 - 0.48;
  part("wall", 0, 1.1, back, width + 1.1, 2.2, 0.14);
  part("wallBase", 0, 0.35, back + 0.08, width + 1.1, 0.7, 0.03);
  part("wall", left, 0.72, 0, 0.14, 1.44, height + 1.1);
  part("wallBase", left + 0.08, 0.3, 0, 0.03, 0.6, height + 1.1);
  for (let x = -width / 2; x <= width / 2; x += 4) {
    part("steel", x, 1.2, back + 0.08, 0.14, 2.4, 0.15);
    if (x + 1.9 <= width / 2) part("light", x + 1.25, 2.08, back + 0.12, 1.25, 0.075, 0.08);
  }
  part("shelf", 0, 2.33, back, width + 1.2, 0.12, 0.22);
  part("yellow", 0, 1.84, back + 0.12, width + 0.6, 0.035, 0.035);
  for (let z = -height / 2; z <= height / 2; z += 4) part("steel", left + 0.09, 0.78, z, 0.16, 1.56, 0.14);
  for (const x of [-width * 0.27, width * 0.25]) {
    part("dark", x, 0.91, back + 0.12, 2.5, 1.82, 0.06);
    part("shelf", x, 0.94, back + 0.17, 2.23, 1.69, 0.035);
    for (let y = 0.2; y < 1.72; y += 0.14) part("casing", x, y, back + 0.20, 2.23, 0.018, 0.025);
    for (const offset of [-1.3, 1.3]) {
      part("yellow", x + offset, 0.32, back + 0.23, 0.11, 0.64, 0.11);
      part("dark", x + offset, 0.41, back + 0.23, 0.115, 0.1, 0.115);
    }
  }
  sign("ASSEMBLY / 01", 0, 1.28, back + 0.085, 2.1);
  sign("AGV   /   KEEP CLEAR", -1.8, 0.006, height / 2 + 0.36, 3.5, true);
  part("red", width / 2 - 0.65, 0.78, back + 0.14, 0.32, 0.52, 0.16);
  part("white", width / 2 - 0.65, 0.80, back + 0.225, 0.045, 0.2, 0.01);

  for (const { center, horizontal } of safetyEdges(scenario)) {
    const p = toWorld(center, width, height);
    part("yellow", p.x, 0.006, p.z, horizontal ? 0.98 : 0.035, 0.008, horizontal ? 0.035 : 0.98);
  }
  // Painted perimeter, not a new wall or a one-way routing constraint.
  for (let x = -width / 2 + 0.2; x < width / 2; x += 0.8) part("white", x, 0.005, height / 2 + 0.12, 0.42, 0.006, 0.045);
  for (let z = -height / 2 + 0.2; z < height / 2; z += 0.8) part("white", width / 2 + 0.12, 0.005, z, 0.045, 0.006, 0.42);

  function pallet(x: number, y: number, z: number) {
    for (const offset of [-0.27, 0, 0.27]) part("wood", x + offset, y, z, 0.095, 0.07, 0.72);
    for (const offset of [-0.27, -0.09, 0.09, 0.27]) part("wood", x, y + 0.047, z + offset, 0.73, 0.025, 0.12);
  }
  const fixtures = factoryFixtures(scenario);
  for (const fixture of fixtures) {
    const { x, z } = toWorld(fixture, width, height);
    if (fixture.kind === "machine") {
      part("dark", x, 0.13, z, 0.8, 0.26, 0.76);
      part("casing", x, 0.74, z, 0.83, 1.0, 0.8);
      part("steel", x - 0.13, 0.76, z + 0.405, 0.47, 0.59, 0.025);
      part("dark", x - 0.13, 0.85, z + 0.423, 0.33, 0.33, 0.018);
      part("screen", x + 0.28, 0.96, z + 0.423, 0.14, 0.2, 0.018);
      part("red", x + 0.28, 0.73, z + 0.425, 0.055, 0.055, 0.025);
      for (let i = 0; i < 5; i++) part("dark", x + 0.422, 0.48 + i * 0.045, z, 0.014, 0.016, 0.4);
      part("yellow", x, 1.28, z, 0.22, 0.06, 0.22);
      continue;
    }
    for (const dx of [-0.405, 0.405]) for (const dz of [-0.405, 0.405]) {
      part("steel", x + dx, 0.85, z + dz, 0.045, 1.7, 0.055);
      part("yellow", x + dx, 0.12, z + dz, 0.08, 0.24, 0.085);
    }
    for (const level of [0.15, 0.91, 1.66]) {
      if (level < 1.6) part("shelf", x, level + 0.035, z, 0.85, 0.025, 0.79);
      for (const dz of [-0.405, 0.405]) part("beam", x, level, z + dz, 0.88, 0.075, 0.055);
    }
    pallet(x, 0.23, z);
    for (const offset of [-0.19, 0.19]) {
      const finish = fixture.variant % 3 ? "carton" : "crate";
      part(finish, x + offset, 0.52, z, 0.34, 0.44, 0.62);
      part("tape", x + offset, 0.743, z, 0.075, 0.007, 0.62);
    }
    pallet(x, 1.0, z);
    const boxHeight = 0.31 + (fixture.variant % 3) * 0.07;
    part(fixture.variant % 2 ? "lightCarton" : "carton", x, 1.06 + boxHeight / 2, z, 0.65, boxHeight, 0.58);
    part("tape", x, 1.063 + boxHeight, z, 0.075, 0.007, 0.58);
    part("white", x - 0.2, 1.18, z + 0.292, 0.12, 0.075, 0.007);
  }

  for (const point of scenario.chargingStations) {
    const { x, z } = toWorld(point, width, height);
    // Dock furniture stays at the edge of its charging cell; center remains free.
    part("steel", x, 0.22, z - 0.39, 0.65, 0.44, 0.14);
    part("screen", x, 0.30, z - 0.315, 0.36, 0.075, 0.012);
    part("yellow", x - 0.36, 0.075, z - 0.32, 0.05, 0.15, 0.18);
    part("yellow", x + 0.36, 0.075, z - 0.32, 0.05, 0.15, 0.18);
  }

  for (const [name, batch] of batches) {
    const mesh = new THREE.InstancedMesh(batch.geometry, batch.material, batch.matrices.length);
    batch.matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
    mesh.castShadow = name !== "light";
    mesh.receiveShadow = true;
    mesh.name = `factory-${name}`;
    scene.add(mesh);
  }
  return { racks: fixtures.filter((fixture) => fixture.kind === "rack").length, machines: fixtures.filter((fixture) => fixture.kind === "machine").length };
}
