import * as THREE from "three";
import { buildFactoryEnvironment } from "./factory-environment";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { isOrderMarkerVisible, progressiveRoute, routeCapacity, shouldAnimateFleetMove, toWorld, type GridPoint, type MazeFrame, type MazeRobot, type MazeScenario, type RouteSegment } from "./maze-model";
import { createRobotMotion, retimeRobotMotion, sampleRobotMotion, type RobotMotion } from "./replay-motion";
import { buildForkliftPayload, LOADED_FORK_LIFT } from "./forklift-payload";

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
};
type RouteVisual = {
  mesh: THREE.InstancedMesh;
  joints: THREE.InstancedMesh;
  material: THREE.MeshBasicMaterial;
};
type TrailTip = {
  group: THREE.Group;
  body: THREE.Mesh;
  startCap: THREE.Mesh;
  endCap: THREE.Mesh;
};

/** Browser-only, demand-rendered scene. All coordinates come from the replay. */
export class WarehouseRenderer {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-12, 12, 10, -10, 0.1, 120);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly textures = new Set<THREE.Texture>();
  private readonly closures = new Map<string, THREE.Group>();
  private readonly orderMarkers: THREE.Group[][] = [];
  private readonly route: RouteVisual;
  private readonly robots = new Map<string, RobotVisual>();
  private trailTip: TrailTip | null = null;
  private trailRobot: RobotVisual | null = null;
  private readonly trailOrigin = new THREE.Vector3();
  private readonly trailEnd = new THREE.Vector3();
  private readonly trailDirection = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
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
      this.route = this.makeRoute();
      this.trailTip = this.makeTrailTip(this.route);
      this.host.append(this.renderer.domElement);
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
    context.roundRect(8, 8, 112, 112, 28);
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
    const chargerMaterial = this.standard(0x789da3);
    this.scenario.chargingStations.forEach((point) => {
      const disc = new THREE.Mesh(markerGeometry, chargerMaterial);
      disc.position.copy(this.world(point, 0.009));
      const label = this.badge("charge", "#8bbeef", "#162c44");
      label.position.copy(this.world(point, 0.4));
      this.scene.add(disc, label);
    });
    this.scenario.orders.forEach((order, index) => {
      const groups = [order.pickup, order.dropoff].map((point, endpoint) => {
        const group = new THREE.Group();
        group.position.copy(this.world(point));
        const pickup = endpoint === 0;
        const material = this.standard(pickup ? 0x285249 : 0x675f42);
        material.transparent = true;
        const base = new THREE.Mesh(markerGeometry, material);
        base.position.y = 0.01;
        const label = this.badge(`${pickup ? "P" : "D"}${index + 1}`, pickup ? "#7ed7ad" : "#e5bd75");
        label.position.set(pickup ? -0.12 : 0.12, 0.48, pickup ? -0.12 : 0.12);
        group.add(base, label);
        this.scene.add(group);
        return group;
      });
      this.orderMarkers.push(groups);
    });
    this.renderer.domElement.dataset.totalTaskPointCount = String(this.scenario.orders.length * 2);
  }

  private makeRobot(letter: string, color: string): RobotVisual {
    const group = new THREE.Group();
    const chassis = new THREE.Group();
    const tint = this.standard(color);
    const white = this.standard(0xf7faff);
    const dark = this.standard(0x354457);
    const bumper = new THREE.Mesh(this.geometry(new RoundedBoxGeometry(0.66, 0.12, 0.74, 2, 0.035)), dark);
    bumper.position.y = 0.17;
    bumper.castShadow = true;
    const body = new THREE.Mesh(this.geometry(new RoundedBoxGeometry(0.57, 0.28, 0.65, 3, 0.08)), white);
    body.position.y = 0.24;
    body.castShadow = true;
    const top = new THREE.Mesh(this.geometry(new THREE.CylinderGeometry(0.2, 0.22, 0.075, 24)), tint);
    top.position.y = 0.415;
    top.castShadow = true;
    const lidar = new THREE.Mesh(this.geometry(new THREE.CylinderGeometry(0.075, 0.075, 0.075, 16)), dark);
    lidar.position.set(0, 0.49, -0.13);
    const lightMaterial = this.material(new THREE.MeshStandardMaterial({ color: 0xc5e7f0, emissive: 0x5d9dbb, emissiveIntensity: 1 }));
    for (const x of [-0.2, 0.2]) {
      const light = new THREE.Mesh(this.geometry(new THREE.BoxGeometry(0.10, 0.035, 0.015)), lightMaterial);
      light.position.set(x, 0.27, 0.333);
      chassis.add(light);
    }
    const wheelGeometry = this.geometry(new THREE.CylinderGeometry(0.115, 0.115, 0.08, 16));
    for (const x of [-0.3, 0.3]) {
      for (const z of [-0.2, 0.2]) {
        const wheel = new THREE.Mesh(wheelGeometry, dark);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(x, 0.12, z);
        wheel.castShadow = true;
        chassis.add(wheel);
      }
    }
    const ring = new THREE.Mesh(
      this.geometry(new THREE.RingGeometry(0.34, 0.4, 40)),
      this.material(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, depthWrite: false })),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.025;
    const badge = this.badge(letter, "#071f27", color, true);
    badge.position.y = 1.7;
    // The carriage carries both forks and cargo; empty forks return to floor height.
    const lift = new THREE.Group();
    for (const x of [-0.19, 0.19]) {
      const mast = new THREE.Mesh(this.geometry(new THREE.BoxGeometry(0.055, 0.84, 0.065)), dark);
      mast.position.set(x, 0.57, 0.21);
      const fork = new THREE.Mesh(this.geometry(new THREE.BoxGeometry(0.075, 0.035, 0.3)), dark);
      fork.position.set(x, 0.15, 0.33);
      mast.castShadow = fork.castShadow = true;
      chassis.add(mast);
      lift.add(fork);
    }
    const payload = buildForkliftPayload({ geometry: (value) => this.geometry(value), material: (value) => this.material(value) });
    lift.add(payload);
    chassis.add(bumper, body, top, lidar, ring, lift);
    group.add(chassis, badge);
    group.name = `robot-${letter}`;
    this.scene.add(group);
    return { group, chassis, tint, badge, payload, lift, color, target: null, motion: null };
  }

  private makeRoute(): RouteVisual {
    const material = this.material(new THREE.MeshBasicMaterial({ color: 0x007aff, toneMapped: false }));
    const capacity = routeCapacity(this.scenario.width, this.scenario.height);
    const mesh = new THREE.InstancedMesh(
      this.geometry(new THREE.CylinderGeometry(0.033, 0.033, 1, 8)),
      material,
      capacity.segments,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    const joints = new THREE.InstancedMesh(
      this.geometry(new THREE.SphereGeometry(0.033, 8, 6)), material,
      capacity.joints,
    );
    joints.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    joints.frustumCulled = false;
    joints.count = 0;
    this.scene.add(mesh, joints);
    return { mesh, joints, material };
  }

  private makeTrailTip(route: RouteVisual): TrailTip {
    const group = new THREE.Group();
    const body = new THREE.Mesh(route.mesh.geometry, route.material);
    const startCap = new THREE.Mesh(route.joints.geometry, route.material);
    const endCap = new THREE.Mesh(route.joints.geometry, route.material);
    group.add(body, startCap, endCap);
    group.visible = false;
    this.scene.add(group);
    return { group, body, startCap, endCap };
  }

  private updateRoute(route: RouteVisual, segments: RouteSegment[], color: string, elevation: number) {
    const transform = new THREE.Object3D();
    const joints = new Map<string, GridPoint>();
    segments.forEach(({ from, to }, index) => {
      const start = this.world(from, elevation);
      const end = this.world(to, elevation);
      const direction = end.clone().sub(start);
      transform.position.copy(start).add(end).multiplyScalar(0.5);
      transform.quaternion.setFromUnitVectors(this.up, direction.clone().normalize());
      transform.scale.set(1, direction.length(), 1);
      transform.updateMatrix();
      route.mesh.setMatrixAt(index, transform.matrix);
      joints.set(`${from.x}:${from.y}`, from);
      joints.set(`${to.x}:${to.y}`, to);
    });
    route.mesh.count = segments.length;
    route.mesh.instanceMatrix.needsUpdate = true;
    transform.quaternion.identity();
    transform.scale.setScalar(1);
    let index = 0;
    for (const point of joints.values()) {
      transform.position.copy(this.world(point, elevation));
      transform.updateMatrix();
      route.joints.setMatrixAt(index++, transform.matrix);
    }
    route.joints.count = index;
    route.joints.instanceMatrix.needsUpdate = true;
    route.material.color.set(color);
  }

  private moveRobot(visual: RobotVisual, data: MazeRobot, label: string, frame: MazeFrame, now: number) {
    visual.group.visible = true;
    if (visual.color !== data.color) {
      visual.color = data.color;
      visual.tint.color.set(data.color);
      const material = visual.badge.material;
      if (material.map) { material.map.dispose(); this.textures.delete(material.map); }
      material.map = this.labelTexture(label, "#071f27", data.color);
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
    visual.group.position.copy(this.world(sample.position));
    visual.chassis.rotation.y = sample.heading;
    if (sample.complete) visual.motion = null;
  }

  private updateTrailTip() {
    const tip = this.trailTip;
    if (!tip) return;
    tip.group.visible = Boolean(this.trailRobot);
    if (!this.trailRobot) return;
    this.trailEnd.copy(this.trailRobot.group.position);
    this.trailEnd.y = this.trailOrigin.y;
    this.trailDirection.copy(this.trailEnd).sub(this.trailOrigin);
    const length = this.trailDirection.length();
    tip.body.visible = length > 0.0001;
    if (tip.body.visible) {
      tip.body.position.copy(this.trailOrigin).add(this.trailEnd).multiplyScalar(0.5);
      tip.body.quaternion.setFromUnitVectors(this.up, this.trailDirection.normalize());
      tip.body.scale.set(1, length, 1);
    }
    tip.startCap.position.copy(this.trailOrigin);
    tip.endCap.position.copy(this.trailEnd);
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
    const fleet = frame.fleet;
    const activeIds = new Set(fleet.map((robot) => robot.id));
    this.robots.forEach((visual, id) => {
      if (!activeIds.has(id)) { visual.group.visible = false; visual.motion = null; }
    });
    fleet.forEach((robot) => {
      let visual = this.robots.get(robot.id);
      if (!visual) {
        visual = this.makeRobot(robot.label ?? robot.id, robot.color);
        this.robots.set(robot.id, visual);
      }
      this.moveRobot(visual, robot, robot.label ?? robot.id, frame, now);
      visual.badge.scale.setScalar(robot.id === frame.primary.id ? 0.95 : 0.8);
    });
    const primary = this.robots.get(frame.primary.id);
    const trail = progressiveRoute(frame.primaryRoute, Boolean(primary?.motion));
    this.updateRoute(this.route, trail.segments, frame.primary.color, 0.06);
    this.trailRobot = trail.tip && primary ? primary : null;
    if (trail.tip) this.trailOrigin.copy(this.world(trail.tip.from, 0.06));
    this.updateTrailTip();
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
      const opacity = highlighted ? 1 : state === "delivered" ? 0.22 : 1;
      markers.forEach((group, endpoint) => {
        group.visible = isOrderMarkerVisible(state);
        if (!group.visible) return;
        group.scale.setScalar(highlighted ? 1.25 : 1);
        group.traverse((object) => {
          if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) {
            const material = object.material as THREE.MeshStandardMaterial | THREE.SpriteMaterial;
            material.opacity = opacity;
            if (object instanceof THREE.Sprite) {
              material.depthTest = !highlighted;
              object.renderOrder = highlighted ? 15 : 0;
            }
            if (object instanceof THREE.Mesh) {
              material.color.set(highlighted ? 0xc9ee96 : state === "expired" ? 0xc8856e : state === "carried" ? frame.orderColors?.[index] ?? 0x285249 : endpoint === 0 ? 0x285249 : 0x675f42);
            }
          }
        });
      });
    });
    const canvas = this.renderer.domElement;
    canvas.dataset.taskPointCount = String(this.orderMarkers.filter((markers) => markers[0].visible).length * 2);
    canvas.setAttribute("aria-label", `${frame.description} Drag or use arrow keys to orbit; plus and minus to zoom; Home to reset the camera.`);
    canvas.dataset.time = String(frame.time);
    canvas.dataset.primaryPosition = `${frame.primary.position.x},${frame.primary.position.y}`;
    canvas.dataset.blockedCount = String(frame.blocked.length);
    canvas.dataset.obstacleCount = String(this.scenario.obstacles.length);
    canvas.dataset.vehicleCount = String(fleet.length);
    canvas.dataset.vehiclePositions = JSON.stringify(fleet.map(({ id, position }) => ({ id, ...position })));
    canvas.dataset.carryingCount = String(fleet.filter((robot) => robot.carrying).length);
    canvas.dataset.highlightedOrder = frame.highlightedOrderId ?? "";
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
    this.updateTrailTip();
    this.renderer.render(this.scene, this.camera);
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
      trailHead: this.trailRobot ? {
        x: this.trailEnd.x + (this.scenario.width - 1) / 2,
        y: this.trailEnd.z + (this.scenario.height - 1) / 2,
      } : null,
    });
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
    this.trailRobot = null;
    this.trailTip = null;
    this.robots.clear();
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
