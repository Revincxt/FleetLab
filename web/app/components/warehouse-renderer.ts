import * as THREE from "three";
import { buildFactoryEnvironment } from "./factory-environment";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { dashedRouteSegments, isOrderEndpointVisible, progressiveRoute, routeCapacity, routeSegments, shouldAnimateFleetMove, toWorld, type GridPoint, type MazeFrame, type MazeRobot, type MazeScenario, type RouteSegment } from "./maze-model";
import { createRobotMotion, retimeRobotMotion, sampleRobotMotion, type RobotMotion } from "./replay-motion";
import { buildForkliftPayload, LOADED_FORK_LIFT } from "./forklift-payload";
import { buildIndustrialForklift } from "./factory-forklift";
import { buildWorkerTracks, interpolateWorker, type WorkerPose, type WorkerTrack, type WorkerTrafficFrame } from "./workforce-model";
import { poseWorker, workerFactory, type WorkerVisual } from "./factory-workers";
import { ForkliftNotices } from "./forklift-notices";

type RendererCallbacks = {
  onZoom: (zoom: number) => void;
  onUnavailable: () => void;
};
type RobotVisual = {
  group: THREE.Group;
  chassis: THREE.Group;
  tint: THREE.MeshStandardMaterial;
  badge: THREE.Sprite;
  payload: THREE.Group;
  lift: THREE.Group;
  color: string;
  target: GridPoint | null;
  motion: RobotMotion | null;
  wheels: THREE.Group[];
};
type TaskMarkerVisual = { group: THREE.Group; ink: THREE.MeshBasicMaterial; label: THREE.Sprite | null };
type RouteVisual = {
  mesh: THREE.InstancedMesh;
  joints: THREE.InstancedMesh;
  outline: THREE.InstancedMesh;
  outlineJoints: THREE.InstancedMesh;
  material: THREE.MeshBasicMaterial;
  dashed: boolean;
  offset: THREE.Vector3;
};
type TrailTip = {
  group: THREE.Group;
  body: THREE.Mesh;
  startCap: THREE.Mesh;
  endCap: THREE.Mesh;
  outlineBody: THREE.Mesh;
  outlineStartCap: THREE.Mesh;
  outlineEndCap: THREE.Mesh;
};
type VehicleRouteVisual = {
  solid: RouteVisual;
  planned: RouteVisual;
  plannedLeadMesh: THREE.InstancedMesh;
  plannedLeadOutline: THREE.InstancedMesh;
  plannedLead: { robot: RobotVisual; edge: RouteSegment } | null;
  trailTip: TrailTip;
  trailRobot: RobotVisual | null;
  trailOrigin: THREE.Vector3;
  trailEnd: THREE.Vector3;
  orderId: string | null;
};
type WorkerPresentation = {
  visual: WorkerVisual;
  track: WorkerTrack;
  pose: WorkerPose;
  motion: { from: WorkerPose; to: WorkerPose; startedAt: number; duration: number } | null;
};

const ROUTE_ELEVATION = 0.105;

/** Demand-rendered replay of forklifts and cell-occupying workers. */
export class WarehouseRenderer {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-12, 12, 10, -10, 0.1, 120);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly textures = new Set<THREE.Texture>();
  private readonly closures = new Map<string, THREE.Group>();
  private readonly orderMarkers: TaskMarkerVisual[][] = [];
  private readonly routes = new Map<string, VehicleRouteVisual>();
  private readonly leadTransform = new THREE.Object3D();
  private readonly robots = new Map<string, RobotVisual>();
  private readonly workers: WorkerPresentation[] = [];
  private readonly trailDirection = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private notices: ForkliftNotices | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private previous: MazeFrame | null = null;
  private animationFrame: number | null = null;
  private visible = true;
  private disposed = false;
  private sceneWidth = 1;
  private sceneHeight = 1;

  constructor(
    private readonly host: HTMLDivElement,
    private readonly scenario: MazeScenario,
    frame: MazeFrame,
    private readonly callbacks: RendererCallbacks,
    traffic: WorkerTrafficFrame[],
    workerMoveSteps: number,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    try {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
      this.renderer.domElement.tabIndex = 0;
      this.renderer.domElement.title = "Drag to orbit · Scroll to zoom";
      this.renderer.domElement.setAttribute("role", "img");
      this.renderer.domElement.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight ArrowUp ArrowDown + - Home");
      this.renderer.domElement.addEventListener("keydown", this.onKeyDown);
      this.renderer.domElement.addEventListener("webglcontextlost", this.onContextLost);

      this.camera.position.set(17, 21, 24);
      this.controls.target.set(0, 0.25, 0);
      this.controls.enablePan = false;
      this.controls.enableDamping = false;
      this.controls.minPolarAngle = 0;
      this.controls.maxPolarAngle = Math.PI * 0.39;
      this.controls.minZoom = 0.65;
      this.controls.maxZoom = 2.75;
      this.controls.rotateSpeed = 0.65;
      this.controls.zoomSpeed = 0.7;
      this.controls.update();
      this.controls.saveState();
      this.controls.addEventListener("change", this.onCameraChange);

      this.buildEnvironment();
      const makeWorker = workerFactory({ geometry: value => this.geometry(value), material: value => this.material(value) });
      buildWorkerTracks(traffic, workerMoveSteps).forEach((track, index) => {
        const visual = makeWorker(index);
        this.scene.add(visual.group);
        this.workers.push({ visual, track, pose: track.frames[0], motion: null });
      });
      this.renderer.domElement.dataset.workerCount = String(this.workers.length);
      this.renderer.domElement.dataset.workerMode = "cell-reserved";
      this.host.append(this.renderer.domElement);
      this.notices = new ForkliftNotices(this.host, this.invalidate, scenario.orders);
      this.resizeObserver = new ResizeObserver(this.resize);
      this.resizeObserver.observe(this.host);
      this.intersectionObserver = new IntersectionObserver(([entry]) => {
        this.visible = entry.isIntersecting;
        if (this.visible) this.invalidate();
      });
      this.intersectionObserver.observe(this.host);
      document.addEventListener("visibilitychange", this.onVisibilityChange);
      this.reducedMotion.addEventListener("change", this.onReducedMotionChange);
      this.resize();
      this.update(frame);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private geometry<T extends THREE.BufferGeometry>(value: T): T {
    this.geometries.add(value);
    return value;
  }

  private material<T extends THREE.Material>(value: T): T {
    this.materials.add(value);
    return value;
  }

  private standard(color: THREE.ColorRepresentation) {
    return this.material(new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.03 }));
  }

  private world(point: GridPoint, elevation = 0) {
    const value = toWorld(point, this.scenario.width, this.scenario.height, elevation);
    return new THREE.Vector3(value.x, value.y, value.z);
  }

  private labelTexture(text: string, color: string, background = "#17303a") {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas labels are unavailable");
    context.fillStyle = background;
    context.beginPath();
    context.roundRect(8, 8, 112, 112, 12);
    context.fill();
    context.strokeStyle = color;
    context.lineWidth = 3;
    context.stroke();
    context.fillStyle = color;
    if (text === "charge") {
      context.beginPath();
      context.moveTo(73, 24);
      context.lineTo(38, 70);
      context.lineTo(62, 70);
      context.lineTo(54, 103);
      context.lineTo(90, 55);
      context.lineTo(66, 55);
      context.closePath();
      context.fill();
    } else {
      context.font = `600 ${text.length > 2 ? 36 : 48}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(text, 64, 66);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    this.textures.add(texture);
    return texture;
  }

  private badge(text: string, color: string, background?: string, alwaysVisible = false) {
    const material = this.material(new THREE.SpriteMaterial({
      map: this.labelTexture(text, color, background),
      depthTest: !alwaysVisible,
      depthWrite: false,
      toneMapped: false,
    }));
    const sprite = new THREE.Sprite(material);
    sprite.scale.setScalar(alwaysVisible ? 0.82 : 0.72);
    if (alwaysVisible) sprite.renderOrder = 20;
    return sprite;
  }

  private buildEnvironment() {
    const fixtures = buildFactoryEnvironment(this.scene, this.scenario, {
      geometry: (value) => this.geometry(value),
      material: (value) => this.material(value),
      texture: (value) => { this.textures.add(value); return value; },
    });
    this.renderer.domElement.dataset.factoryRacks = String(fixtures.racks);
    this.renderer.domElement.dataset.factoryMachines = String(fixtures.machines);
    const markerGeometry = this.geometry(new THREE.BoxGeometry(0.82, 0.009, 0.82));
    const chargerMaterial = this.standard(0x547369);
    this.scenario.chargingStations.forEach((point) => {
      const disc = new THREE.Mesh(markerGeometry, chargerMaterial);
      disc.position.copy(this.world(point, 0.009));
      const label = new THREE.Mesh(this.geometry(new THREE.PlaneGeometry(0.40, 0.40)), this.material(new THREE.MeshBasicMaterial({ map: this.labelTexture("charge", "#aec7b9", "#253b35"), transparent: true, depthWrite: false, toneMapped: false })));
      label.rotation.x = -Math.PI / 2;
      label.position.copy(this.world(point, 0.02));
      this.scene.add(disc, label);
    });
    // Shared floor stencils replace hundreds of floating task billboards.
    const corners: number[] = [];
    const rectangle = (x: number, z: number, width: number, depth: number) => {
      const a = [x - width / 2, 0, z - depth / 2], b = [x + width / 2, 0, z - depth / 2];
      const c = [x + width / 2, 0, z + depth / 2], d = [x - width / 2, 0, z + depth / 2];
      corners.push(...a, ...d, ...b, ...b, ...d, ...c);
    };
    for (const x of [-1, 1]) for (const z of [-1, 1]) {
      rectangle(x * 0.27, z * 0.34, 0.17, 0.035);
      rectangle(x * 0.34, z * 0.27, 0.035, 0.17);
    }
    const stencilGeometry = this.geometry(new THREE.BufferGeometry());
    stencilGeometry.setAttribute("position", new THREE.Float32BufferAttribute(corners, 3));
    const glyphGeometry = this.geometry(new THREE.PlaneGeometry(0.27, 0.27));
    const glyphs = [this.labelTexture("P", "#a2c7b4", "#263a32"), this.labelTexture("D", "#dbc08c", "#3a3326")].map(map => this.material(new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, toneMapped: false })));
    this.scenario.orders.forEach((order, index) => {
      const groups = [order.pickup, order.dropoff].map((point, endpoint) => {
        const group = new THREE.Group();
        group.position.copy(this.world(point));
        const pickup = endpoint === 0;
        group.name = `task-${index + 1}-${pickup ? "pickup" : "delivery"}`;
        const ink = this.material(new THREE.MeshBasicMaterial({ color: pickup ? 0x8db79f : 0xcfaf75, transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false }));
        const base = new THREE.Mesh(stencilGeometry, ink);
        base.position.y = pickup ? 0.018 : 0.02;
        const glyph = new THREE.Mesh(glyphGeometry, glyphs[endpoint]);
        glyph.rotation.x = -Math.PI / 2;
        glyph.position.set(pickup ? -0.17 : 0.17, 0.024, 0);
        group.add(base, glyph);
        this.scene.add(group);
        return { group, ink, label: null };
      });
      this.orderMarkers.push(groups);
    });
    this.renderer.domElement.dataset.totalTaskPointCount = String(this.scenario.orders.length * 2);
  }

  private makeRobot(letter: string, color: string): RobotVisual {
    const group = new THREE.Group();
    const { chassis, lift, wheels, tint } = buildIndustrialForklift({ geometry: value => this.geometry(value), material: value => this.material(value) }, color);
    const ring = new THREE.Mesh(
      this.geometry(new THREE.RingGeometry(0.37, 0.39, 32)),
      this.material(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false })),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.025;
    const badge = this.badge(letter, color, "#1b2429", true);
    badge.position.y = 1.45;
    // The carriage carries both forks and cargo; empty forks return to floor height.
    const payload = buildForkliftPayload({ geometry: (value) => this.geometry(value), material: (value) => this.material(value) });
    lift.add(payload);
    chassis.add(ring);
    group.add(chassis, badge);
    group.name = `robot-${letter}`;
    this.scene.add(group);
    return { group, chassis, tint, badge, payload, lift, wheels, color, target: null, motion: null };
  }

  private makeRoute(dashed = false, lane = 0): RouteVisual {
    const radius = dashed ? 0.041 : 0.038;
    // Muted strokes stay legible over concrete with a narrow, softer dark border.
    const material = this.material(new THREE.MeshBasicMaterial({ color: 0xc9ee96, transparent: true, opacity: 1, depthWrite: false, toneMapped: false }));
    const outlineMaterial = this.material(new THREE.MeshBasicMaterial({ color: 0x26343b, transparent: true, opacity: 0.76, depthWrite: false, toneMapped: false }));
    const capacity = routeCapacity(this.scenario.width, this.scenario.height);
    const mesh = new THREE.InstancedMesh(
      this.geometry(new THREE.CylinderGeometry(radius, radius, 1, 8)),
      material,
      capacity.segments * (dashed ? 3 : 1),
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    const joints = new THREE.InstancedMesh(
      this.geometry(new THREE.SphereGeometry(radius, 8, 6)), material,
      dashed ? 1 : capacity.joints,
    );
    joints.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    joints.frustumCulled = false;
    joints.count = 0;
    const outline = new THREE.InstancedMesh(
      this.geometry(new THREE.CylinderGeometry(radius + 0.017, radius + 0.017, 1, 8)),
      outlineMaterial, mesh.instanceMatrix.count,
    );
    const outlineJoints = new THREE.InstancedMesh(
      this.geometry(new THREE.SphereGeometry(radius + 0.017, 8, 6)), outlineMaterial, joints.instanceMatrix.count,
    );
    for (const stroke of [outline, outlineJoints]) {
      stroke.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      stroke.frustumCulled = false;
      stroke.count = 0;
      stroke.renderOrder = 10;
    }
    mesh.renderOrder = joints.renderOrder = 11;
    this.scene.add(outline, outlineJoints, mesh, joints);
    return { mesh, joints, outline, outlineJoints, material, dashed, offset: new THREE.Vector3(lane, 0, lane) };
  }

  private makeTrailTip(route: RouteVisual): TrailTip {
    const group = new THREE.Group();
    const body = new THREE.Mesh(route.mesh.geometry, route.material);
    const startCap = new THREE.Mesh(route.joints.geometry, route.material);
    const endCap = new THREE.Mesh(route.joints.geometry, route.material);
    const outlineBody = new THREE.Mesh(route.outline.geometry, route.outline.material);
    const outlineStartCap = new THREE.Mesh(route.outlineJoints.geometry, route.outlineJoints.material);
    const outlineEndCap = new THREE.Mesh(route.outlineJoints.geometry, route.outlineJoints.material);
    for (const stroke of [body, startCap, endCap]) stroke.renderOrder = 11;
    for (const stroke of [outlineBody, outlineStartCap, outlineEndCap]) stroke.renderOrder = 10;
    group.add(outlineBody, outlineStartCap, outlineEndCap, body, startCap, endCap);
    group.visible = false;
    this.scene.add(group);
    return { group, body, startCap, endCap, outlineBody, outlineStartCap, outlineEndCap };
  }

  private makeVehicleRoute(lane: number): VehicleRouteVisual {
    const solid = this.makeRoute(false, lane);
    const planned = this.makeRoute(true, lane);
    const plannedLeadMesh = new THREE.InstancedMesh(planned.mesh.geometry, planned.material, 3);
    plannedLeadMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    plannedLeadMesh.frustumCulled = false;
    plannedLeadMesh.count = 0;
    plannedLeadMesh.renderOrder = 11;
    const plannedLeadOutline = new THREE.InstancedMesh(planned.outline.geometry, planned.outline.material, 3);
    plannedLeadOutline.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    plannedLeadOutline.frustumCulled = false;
    plannedLeadOutline.count = 0;
    plannedLeadOutline.renderOrder = 10;
    this.scene.add(plannedLeadOutline, plannedLeadMesh);
    return {
      solid, planned, plannedLeadMesh, plannedLeadOutline, plannedLead: null,
      trailTip: this.makeTrailTip(solid), trailRobot: null,
      trailOrigin: new THREE.Vector3(), trailEnd: new THREE.Vector3(), orderId: null,
    };
  }

  private clearVehicleRoute(route: VehicleRouteVisual) {
    route.orderId = null;
    route.solid.mesh.count = route.solid.joints.count = 0;
    route.planned.mesh.count = route.planned.joints.count = route.plannedLeadMesh.count = 0;
    route.solid.outline.count = route.solid.outlineJoints.count = 0;
    route.planned.outline.count = route.planned.outlineJoints.count = route.plannedLeadOutline.count = 0;
    route.trailRobot = route.plannedLead = null;
    route.trailTip.group.visible = false;
  }

  private updateRoute(route: RouteVisual, segments: RouteSegment[], color: string, elevation: number) {
    if (route.dashed) segments = dashedRouteSegments(segments);
    const transform = new THREE.Object3D();
    const joints = new Map<string, GridPoint>();
    segments.forEach(({ from, to }, index) => {
      const start = this.world(from, elevation).add(route.offset);
      const end = this.world(to, elevation).add(route.offset);
      const direction = end.clone().sub(start);
      transform.position.copy(start).add(end).multiplyScalar(0.5);
      transform.quaternion.setFromUnitVectors(this.up, direction.clone().normalize());
      transform.scale.set(1, direction.length(), 1);
      transform.updateMatrix();
      route.mesh.setMatrixAt(index, transform.matrix);
      route.outline.setMatrixAt(index, transform.matrix);
      if (!route.dashed) {
        joints.set(`${from.x}:${from.y}`, from);
        joints.set(`${to.x}:${to.y}`, to);
      }
    });
    route.mesh.count = route.outline.count = segments.length;
    route.mesh.instanceMatrix.needsUpdate = true;
    route.outline.instanceMatrix.needsUpdate = true;
    transform.quaternion.identity();
    transform.scale.setScalar(1);
    let index = 0;
    for (const point of joints.values()) {
      transform.position.copy(this.world(point, elevation)).add(route.offset);
      transform.updateMatrix();
      route.joints.setMatrixAt(index, transform.matrix);
      route.outlineJoints.setMatrixAt(index++, transform.matrix);
    }
    route.joints.count = route.outlineJoints.count = index;
    route.joints.instanceMatrix.needsUpdate = true;
    route.outlineJoints.instanceMatrix.needsUpdate = true;
    route.material.color.set(color);
  }

  private moveRobot(visual: RobotVisual, data: MazeRobot, label: string, frame: MazeFrame, now: number) {
    visual.group.visible = true;
    if (visual.color !== data.color) {
      visual.color = data.color;
      visual.tint.color.set(data.color);
      const material = visual.badge.material;
      if (material.map) { material.map.dispose(); this.textures.delete(material.map); }
      material.map = this.labelTexture(label, data.color, "#1b2429");
      material.needsUpdate = true;
      visual.group.traverse((object) => {
        if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshBasicMaterial) object.material.color.set(data.color);
      });
    }
    visual.badge.material.opacity = data.complete ? 0.65 : 1;
    visual.payload.visible = Boolean(data.carrying);
    visual.lift.position.y = visual.payload.visible ? LOADED_FORK_LIFT : 0;
    this.advanceRobot(visual, now);
    const sameTarget = visual.target?.x === data.position.x && visual.target?.y === data.position.y;
    // Inspector, task and path toggles must not snap an in-flight vehicle to its endpoint.
    if (this.previous?.time === frame.time && sameTarget && visual.motion && !this.reducedMotion.matches) {
      if (this.previous.animate && !frame.animate) {
        const remaining = (1 - sampleRobotMotion(visual.motion, now).progress) * visual.motion.duration;
        visual.motion = retimeRobotMotion(visual.motion, now, Math.min(120, remaining));
      } else if (this.previous.stepDuration !== frame.stepDuration) {
        visual.motion = retimeRobotMotion(visual.motion, now, frame.stepDuration ?? 200);
      }
      return;
    }
    if (visual.target && shouldAnimateFleetMove(this.previous, frame, data.id) && !this.reducedMotion.matches) {
      // Start at the recorded previous cell, not a lagging render sample; never cut a corner.
      visual.motion = createRobotMotion(visual.target, data.position, visual.chassis.rotation.y, now, frame.stepDuration ?? 200);
      visual.group.position.copy(this.world(visual.target));
    } else {
      if (visual.target && !sameTarget) {
        visual.chassis.rotation.y = Math.atan2(data.position.x - visual.target.x, data.position.y - visual.target.y);
      }
      visual.motion = null;
      visual.group.position.copy(this.world(data.position));
    }
    visual.target = { ...data.position };
  }

  private advanceRobot(visual: RobotVisual, now: number) {
    if (!visual.motion) return;
    const sample = sampleRobotMotion(visual.motion, now);
    const position = this.world(sample.position);
    const distance = visual.group.position.distanceTo(position);
    visual.wheels.forEach(wheel => { wheel.rotation.x += distance / 0.105; });
    visual.group.position.copy(position);
    visual.chassis.rotation.y = sample.heading;
    if (sample.complete) visual.motion = null;
  }

  private updateTrailTip(route: VehicleRouteVisual) {
    const { trailTip: tip, trailRobot: robot, trailEnd: end, trailOrigin: origin } = route;
    tip.group.visible = Boolean(robot);
    if (!robot) return;
    end.copy(robot.group.position);
    end.y = origin.y;
    this.trailDirection.copy(end).sub(origin);
    const length = this.trailDirection.length();
    tip.body.visible = length > 0.0001;
    tip.outlineBody.visible = tip.body.visible;
    if (tip.body.visible) {
      tip.body.position.copy(origin).add(end).multiplyScalar(0.5);
      tip.body.quaternion.setFromUnitVectors(this.up, this.trailDirection.normalize());
      tip.body.scale.set(1, length, 1);
      tip.outlineBody.position.copy(tip.body.position);
      tip.outlineBody.quaternion.copy(tip.body.quaternion);
      tip.outlineBody.scale.copy(tip.body.scale);
    }
    tip.startCap.position.copy(origin);
    tip.endCap.position.copy(end);
    tip.outlineStartCap.position.copy(origin);
    tip.outlineEndCap.position.copy(end);
  }

  private updatePlannedLead(route: VehicleRouteVisual) {
    const lead = route.plannedLead;
    route.plannedLeadMesh.count = route.plannedLeadOutline.count = 0;
    if (!lead) return;
    const from = this.world(lead.edge.from);
    const progress = Math.min(1, from.distanceTo(lead.robot.group.position));
    const segments = dashedRouteSegments([lead.edge], progress);
    const transform = this.leadTransform;
    segments.forEach((segment, index) => {
      const start = this.world(segment.from, ROUTE_ELEVATION).add(route.planned.offset);
      const end = this.world(segment.to, ROUTE_ELEVATION).add(route.planned.offset);
      // The first remaining dash joins the real interpolated forklift position.
      const clippedPoint = this.world(segment.from);
      if (clippedPoint.distanceTo(lead.robot.group.position) < 0.0001) {
        start.copy(lead.robot.group.position); start.y = ROUTE_ELEVATION;
      }
      const direction = end.clone().sub(start);
      transform.position.copy(start).add(end).multiplyScalar(0.5);
      transform.quaternion.setFromUnitVectors(this.up, direction.clone().normalize());
      transform.scale.set(1, direction.length(), 1);
      transform.updateMatrix();
      route.plannedLeadMesh.setMatrixAt(index, transform.matrix);
      route.plannedLeadOutline.setMatrixAt(index, transform.matrix);
    });
    route.plannedLeadMesh.count = route.plannedLeadOutline.count = segments.length;
    route.plannedLeadMesh.instanceMatrix.needsUpdate = true;
    route.plannedLeadOutline.instanceMatrix.needsUpdate = true;
  }

  private updateWorkers(frame: MazeFrame, now: number) {
    this.advanceWorkers(now);
    for (const worker of this.workers) {
      if (this.previous?.time === frame.time && !this.reducedMotion.matches) {
        if (worker.motion && (this.previous.animate !== frame.animate || this.previous.stepDuration !== frame.stepDuration)) {
          const progress = Math.min(1, (now - worker.motion.startedAt) / worker.motion.duration);
          const remaining = frame.animate ? frame.stepDuration ?? 260 : Math.min(120, (1 - progress) * worker.motion.duration);
          worker.motion.duration = Math.max(1, remaining) / Math.max(0.001, 1 - progress);
          worker.motion.startedAt = now - progress * worker.motion.duration;
        }
        continue;
      }
      const time = Math.max(0, Math.min(worker.track.frames.length - 1, frame.time));
      const pose = worker.track.frames[time];
      if (frame.animate && this.previous && frame.time === this.previous.time + 1 && !this.reducedMotion.matches) {
        worker.motion = { from: worker.track.frames[Math.max(0, time - 1)], to: pose, startedAt: now, duration: frame.stepDuration ?? 260 };
      } else {
        worker.pose = pose;
        worker.motion = null;
      }
    }
    this.advanceWorkers(now);
  }

  private advanceWorkers(now: number) {
    let moving = false;
    for (const worker of this.workers) {
      if (worker.motion) {
        const progress = Math.min(1, (now - worker.motion.startedAt) / worker.motion.duration);
        worker.pose = interpolateWorker(worker.motion.from, worker.motion.to, progress);
        if (progress === 1) worker.motion = null;
        else moving = true;
      }
      worker.visual.group.position.copy(this.world(worker.pose.position));
      poseWorker(worker.visual, worker.pose);
    }
    return moving;
  }

  private makeClosure(point: GridPoint) {
    const group = new THREE.Group();
    group.position.copy(this.world(point));
    const yellow = this.standard(0xd5a943);
    const dark = this.standard(0x3d4648);
    for (const x of [-0.34, 0.34]) {
      const foot = new THREE.Mesh(this.geometry(new THREE.BoxGeometry(0.12, 0.06, 0.48)), dark);
      foot.position.set(x, 0.03, 0);
      const post = new THREE.Mesh(this.geometry(new THREE.BoxGeometry(0.055, 0.57, 0.055)), yellow);
      post.position.set(x, 0.31, 0);
      foot.castShadow = post.castShadow = true;
      group.add(foot, post);
    }
    const barrier = new THREE.Mesh(this.geometry(new RoundedBoxGeometry(0.92, 0.19, 0.07, 2, 0.015)), yellow);
    barrier.position.y = 0.48;
    barrier.castShadow = true;
    for (const x of [-0.32, -0.1, 0.12, 0.34]) {
      const stripe = new THREE.Mesh(this.geometry(new THREE.BoxGeometry(0.075, 0.17, 0.073)), dark);
      stripe.position.set(x, 0.48, 0);
      stripe.rotation.z = -0.35;
      group.add(stripe);
    }
    const label = this.badge("×", "#b64936", "#fff4ef");
    label.position.y = 0.98;
    group.add(barrier, label);
    this.scene.add(group);
    return group;
  }

  update(frame: MazeFrame) {
    if (this.disposed) return;
    const now = performance.now();
    this.notices?.step(frame.time, frame.notices, now);
    const fleet = frame.fleet;
    const activeIds = new Set(fleet.map((robot) => robot.id));
    this.robots.forEach((visual, id) => {
      if (!activeIds.has(id)) { visual.group.visible = false; visual.motion = null; }
    });
    this.routes.forEach((route, id) => {
      if (!activeIds.has(id)) this.clearVehicleRoute(route);
    });
    fleet.forEach((robot, index) => {
      let visual = this.robots.get(robot.id);
      if (!visual) {
        visual = this.makeRobot(robot.label ?? robot.id, robot.color);
        this.robots.set(robot.id, visual);
      }
      this.moveRobot(visual, robot, robot.label ?? robot.id, frame, now);
      visual.badge.scale.setScalar(robot.id === frame.primary.id ? 0.8 : 0.68);
      let route = this.routes.get(robot.id);
      if (!route) {
        // Stable display lanes separate shared edges, within the original grid cells.
        route = this.makeVehicleRoute((index - (fleet.length - 1) / 2) * 0.13);
        this.routes.set(robot.id, route);
      }
      const taskRoute = frame.routes[robot.id];
      if (!taskRoute) { this.clearVehicleRoute(route); return; }
      route.orderId = taskRoute.orderId;
      const trail = progressiveRoute(taskRoute.completed, Boolean(visual.motion));
      this.updateRoute(route.solid, trail.segments, robot.color, ROUTE_ELEVATION);
      route.trailRobot = visual;
      route.trailOrigin.copy(this.world(trail.tip?.from ?? taskRoute.completed.at(-1)!, ROUTE_ELEVATION)).add(route.solid.offset);
      this.updateRoute(route.planned, routeSegments(taskRoute.planned), robot.color, ROUTE_ELEVATION);
      const last = taskRoute.completed.at(-2), next = taskRoute.completed.at(-1), motion = visual.motion;
      route.plannedLead = motion && last && next && last.x === motion.from.x && last.y === motion.from.y && next.x === motion.to.x && next.y === motion.to.y
        ? { robot: visual, edge: { from: last, to: next } } : null;
      this.updateTrailTip(route);
      this.updatePlannedLead(route);
    });
    this.closures.forEach((group) => { group.visible = false; });
    frame.blocked.forEach((point) => {
      const key = `${point.x}:${point.y}`;
      let group = this.closures.get(key);
      if (!group) { group = this.makeClosure(point); this.closures.set(key, group); }
      group.visible = true;
    });
    this.orderMarkers.forEach((markers, index) => {
      const state = frame.orderStates[index];
      const highlighted = frame.highlightedOrderId === this.scenario.orders[index].id;
      markers.forEach((marker, endpoint) => {
        const { group, ink } = marker;
        group.visible = isOrderEndpointVisible(state, endpoint);
        if (!group.visible) return;
        group.scale.setScalar(highlighted ? 1.08 : 1);
        ink.opacity = highlighted ? 1 : frame.highlightedOrderId ? 0.4 : 0.7;
        ink.color.set(highlighted ? 0xc9ee96 : state === "carried" ? frame.orderColors?.[index] ?? 0xcfaf75 : endpoint === 0 ? 0x8db79f : 0xcfaf75);
        if (highlighted && !marker.label) {
          marker.label = this.badge(`${endpoint === 0 ? "P" : "D"}${index + 1}`, endpoint === 0 ? "#a2c7b4" : "#dbc08c", "#1b2429", true);
          marker.label.position.set(endpoint === 0 ? -0.12 : 0.12, 0.58, 0);
          marker.label.scale.setScalar(0.66);
          group.add(marker.label);
        }
        if (marker.label) marker.label.visible = highlighted;
      });
    });
    const canvas = this.renderer.domElement;
    canvas.dataset.taskPointCount = String(this.orderMarkers.flat().filter(marker => marker.group.visible).length);
    canvas.dataset.taskLabelCount = String(this.orderMarkers.flat().filter(marker => marker.group.visible && marker.label?.visible).length);
    canvas.setAttribute("aria-label", `${frame.description} Drag or use arrow keys to orbit; plus and minus to zoom; Home to reset the camera.`);
    canvas.dataset.time = String(frame.time);
    canvas.dataset.primaryPosition = `${frame.primary.position.x},${frame.primary.position.y}`;
    canvas.dataset.blockedCount = String(frame.blocked.length);
    canvas.dataset.obstacleCount = String(this.scenario.obstacles.length);
    canvas.dataset.vehicleCount = String(fleet.length);
    canvas.dataset.vehiclePositions = JSON.stringify(fleet.map(({ id, position }) => ({ id, ...position })));
    canvas.dataset.carryingCount = String(fleet.filter((robot) => robot.carrying).length);
    canvas.dataset.highlightedOrder = frame.highlightedOrderId ?? "";
    canvas.dataset.routeScope = "fleet";
    canvas.dataset.routeSource = "recorded-plan";
    this.updateWorkers(frame, now);
    canvas.setAttribute("aria-description", "Each forklift's color identifies its current task route. Solid lines show completed travel; dashed lines show the remaining recorded plan. All fleet routes stay visible regardless of selection. Windowed plans update as the replay advances. Workers occupy grid cells reserved by the forklift planners.");
    this.previous = frame;
    this.invalidate();
  }

  private fitCamera() {
    const aspect = this.sceneWidth / this.sceneHeight;
    this.camera.updateMatrixWorld();
    let extentX = 0;
    let extentY = 0;
    for (const x of [-this.scenario.width / 2 - 0.85, this.scenario.width / 2 + 0.85]) {
      for (const y of [-0.35, 2.4]) {
        for (const z of [-this.scenario.height / 2 - 0.85, this.scenario.height / 2 + 0.85]) {
          const point = new THREE.Vector3(x, y, z).applyMatrix4(this.camera.matrixWorldInverse);
          extentX = Math.max(extentX, Math.abs(point.x));
          extentY = Math.max(extentY, Math.abs(point.y));
        }
      }
    }
    const halfHeight = Math.max(extentY, extentX / aspect) * 1.025;
    this.camera.left = -halfHeight * aspect;
    this.camera.right = halfHeight * aspect;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.updateProjectionMatrix();
  }

  private resize = () => {
    if (this.disposed) return;
    this.sceneWidth = Math.max(1, this.host.clientWidth);
    this.sceneHeight = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(this.sceneWidth, this.sceneHeight, false);
    this.fitCamera();
    this.invalidate();
  };

  private onCameraChange = () => {
    this.callbacks.onZoom(this.camera.zoom);
    this.invalidate();
  };

  private onContextLost = (event: Event) => {
    event.preventDefault();
    if (!this.disposed) this.callbacks.onUnavailable();
  };

  private onVisibilityChange = () => {
    if (!document.hidden) this.invalidate();
  };

  private onReducedMotionChange = () => {
    if (this.previous) this.update(this.previous);
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const rotation = Math.PI / 16;
    switch (event.key) {
      case "ArrowLeft": this.controls.rotateLeft(rotation); break;
      case "ArrowRight": this.controls.rotateLeft(-rotation); break;
      case "ArrowUp": this.controls.rotateUp(rotation); break;
      case "ArrowDown": this.controls.rotateUp(-rotation); break;
      case "+": case "=": this.zoomBy(1.2); break;
      case "-": case "_": this.zoomBy(1 / 1.2); break;
      case "Home": this.reset(); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.controls.update();
  };

  zoomBy(factor: number) {
    this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom * factor, this.controls.minZoom, this.controls.maxZoom);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.onCameraChange();
  }

  topView() {
    this.camera.position.set(0, 32, 0.001);
    this.controls.target.set(0, 0.25, 0);
    this.camera.zoom = 1;
    this.controls.update();
    this.fitCamera();
    this.onCameraChange();
  }

  reset() {
    this.controls.reset();
    this.fitCamera();
    this.onCameraChange();
  }

  private invalidate = () => {
    if (this.disposed || !this.visible || document.hidden || this.animationFrame !== null) return;
    this.animationFrame = window.requestAnimationFrame(this.draw);
  };

  private draw = (now: number) => {
    this.animationFrame = null;
    if (this.disposed || !this.visible || document.hidden) return;
    this.camera.updateMatrixWorld();
    let moving = false;
    for (const robot of this.robots.values()) {
      this.advanceRobot(robot, now);
      moving ||= Boolean(robot.motion);
    }
    for (const route of this.routes.values()) {
      this.updateTrailTip(route);
      this.updatePlannedLead(route);
    }
    moving = this.advanceWorkers(now) || moving;
    this.renderer.render(this.scene, this.camera);
    this.notices?.draw(now, [...this.robots].flatMap(([vehicleId, robot]) => {
      if (!robot.group.visible) return [];
      const point = robot.group.position.clone().add(new THREE.Vector3(0, 1.65, 0)).project(this.camera);
      if (Math.abs(point.x) > 1 || Math.abs(point.y) > 1 || Math.abs(point.z) > 1) return [];
      return [{ vehicleId, label: this.previous?.fleet.find(item => item.id === vehicleId)?.label ?? vehicleId,
        color: robot.color, x: (point.x + 1) * this.sceneWidth / 2, y: (1 - point.y) * this.sceneHeight / 2 }];
    }), this.sceneWidth, this.sceneHeight);
    const canvas = this.renderer.domElement;
    canvas.dataset.camera = `${this.controls.getAzimuthalAngle().toFixed(3)},${this.controls.getPolarAngle().toFixed(3)},${this.camera.zoom.toFixed(3)}`;
    // Read-only presentation diagnostics, separate from the exact recorded grid state.
    canvas.dataset.motionFrame = JSON.stringify({
      time: this.previous?.time, primaryId: this.previous?.primary.id,
      vehicles: [...this.robots].filter(([, robot]) => robot.group.visible).map(([id, robot]) => ({
        id, x: robot.group.position.x + (this.scenario.width - 1) / 2,
        y: robot.group.position.z + (this.scenario.height - 1) / 2, heading: robot.chassis.rotation.y,
        carrying: robot.payload.visible, forkLift: robot.lift.position.y,
      })),
      moving: [...this.robots.values()].filter((robot) => robot.motion).length,
      routes: [...this.routes].filter(([id]) => this.robots.get(id)?.group.visible).map(([id, route]) => ({
        id, orderId: route.orderId, color: `#${route.solid.material.color.getHexString()}`, laneOffset: route.solid.offset.x,
        solidEdges: route.solid.mesh.count, plannedEdges: route.planned.mesh.count / 3,
        trailHead: route.trailRobot ? {
          x: route.trailEnd.x + (this.scenario.width - 1) / 2,
          y: route.trailEnd.z + (this.scenario.height - 1) / 2,
        } : null,
        plannedHead: route.plannedLead && route.plannedLeadMesh.count ? {
          x: route.plannedLead.robot.group.position.x + (this.scenario.width - 1) / 2,
          y: route.plannedLead.robot.group.position.z + (this.scenario.height - 1) / 2,
        } : null,
        plannedDashes: route.planned.mesh.count + route.plannedLeadMesh.count,
      })),
    });
    canvas.dataset.workerFrame = JSON.stringify(this.workers.map(({ track, pose }) => ({
      id: track.id, x: pose.position.x, y: pose.position.y, heading: pose.heading,
      gait: pose.gait, activity: pose.activity,
    })));
    if (moving) this.invalidate();
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.animationFrame !== null) window.cancelAnimationFrame(this.animationFrame);
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.reducedMotion.removeEventListener("change", this.onReducedMotionChange);
    this.renderer.domElement.removeEventListener("keydown", this.onKeyDown);
    this.renderer.domElement.removeEventListener("webglcontextlost", this.onContextLost);
    this.controls.removeEventListener("change", this.onCameraChange);
    this.controls.dispose();
    this.notices?.dispose();
    this.notices = null;
    this.routes.clear();
    this.robots.clear();
    this.workers.length = 0;
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
    this.textures.forEach((texture) => texture.dispose());
    this.scene.traverse((object) => {
      if (object instanceof THREE.InstancedMesh) object.dispose();
      if (object instanceof THREE.DirectionalLight) object.shadow.dispose();
    });
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
