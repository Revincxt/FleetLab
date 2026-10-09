import { FleetNoticeBoard, layoutNotices, noticeCopy, type ActiveNotice, type FleetNotice, type NoticeAnchor } from "./fleet-notice-model";

type NoticeVisual = { id: string; element: HTMLDivElement; stem: SVGLineElement; width: number };
const svgNamespace = "http://www.w3.org/2000/svg";
const icons = {
  route: "m12 3 10 18H2L12 3Zm0 6v5m0 3h.01",
  pickup: "m3 8 9-5 9 5v9l-9 5-9-5V8Zm0 0 9 5 9-5m-9 5v9M8 5l9 5",
  delivery: "m5 12 4 4L19 6",
};

/** Screen-space labels follow the interpolated 3D poses without React frame updates. */
export class ForkliftNotices {
  private readonly board = new FleetNoticeBoard();
  private readonly layer = document.createElement("div");
  private readonly stems = document.createElementNS(svgNamespace, "svg");
  private readonly visuals = new Map<string, NoticeVisual>();
  private wakeup: ReturnType<typeof setTimeout> | null = null;
  private deadline: number | null = null;
  private readonly orderLabels: Map<string, string>;

  constructor(host: HTMLElement, private readonly invalidate: () => void, orders: { id: string }[]) {
    this.orderLabels = new Map(orders.map((order, index) => [order.id, `#${String(index + 1).padStart(3, "0")}`]));
    this.layer.className = "forklift-notices";
    this.layer.setAttribute("role", "log");
    this.layer.setAttribute("aria-label", "Forklift updates");
    this.layer.setAttribute("aria-live", "polite");
    this.layer.setAttribute("aria-relevant", "additions");
    this.stems.classList.add("forklift-notice-stems");
    this.stems.setAttribute("aria-hidden", "true");
    this.layer.append(this.stems);
    host.append(this.layer);
  }

  step(time: number, notices: FleetNotice[], now: number) {
    this.board.step(time, notices, now);
  }

  private create(active: ActiveNotice, anchor: NoticeAnchor, now: number): NoticeVisual {
    const { notice } = active;
    const element = document.createElement("div");
    element.className = "forklift-notice-anchor";
    element.dataset.vehicleId = notice.vehicleId;
    element.dataset.noticeId = notice.id;
    element.dataset.noticeKind = notice.kind;
    element.dataset.orderId = notice.orderId;
    element.style.setProperty("--notice-remaining", `${Math.max(0, active.expiresAt - now - 120)}ms`);
    const description = `AGV ${anchor.label}. ${noticeCopy[notice.kind]}. Task ${this.orderLabels.get(notice.orderId) ?? notice.orderId}.`;
    element.setAttribute("aria-label", description);
    element.title = description;
    const bubble = document.createElement("div");
    bubble.className = "forklift-notice";
    const vehicle = document.createElement("span");
    vehicle.className = "forklift-notice-vehicle";
    vehicle.textContent = anchor.label;
    const icon = document.createElementNS(svgNamespace, "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svgNamespace, "path");
    path.setAttribute("d", icons[notice.kind]);
    icon.append(path);
    const message = document.createElement("span");
    message.className = "forklift-notice-message";
    message.textContent = noticeCopy[notice.kind];
    bubble.append(icon, vehicle, message);
    element.append(bubble);
    const stem = document.createElementNS(svgNamespace, "line");
    stem.setAttribute("stroke", anchor.color);
    this.stems.append(stem);
    this.layer.append(element);
    return { id: notice.id, element, stem, width: Math.ceil(bubble.getBoundingClientRect().width) };
  }

  draw(now: number, anchors: NoticeAnchor[], width: number, height: number) {
    const active = this.board.shown(now);
    const byVehicle = new Map(active.map(item => [item.notice.vehicleId, item]));
    const visibleAnchors = anchors.filter(anchor => byVehicle.has(anchor.vehicleId));
    const visible = new Set(visibleAnchors.map(anchor => anchor.vehicleId));
    for (const [id, visual] of this.visuals) {
      if (!visible.has(id) || byVehicle.get(id)?.notice.id !== visual.id) {
        visual.element.remove(); visual.stem.remove(); this.visuals.delete(id);
      }
    }
    const sizedAnchors = visibleAnchors.map(anchor => {
      const item = byVehicle.get(anchor.vehicleId)!;
      let visual = this.visuals.get(anchor.vehicleId);
      if (!visual) { visual = this.create(item, anchor, now); this.visuals.set(anchor.vehicleId, visual); }
      return { ...anchor, width: visual.width };
    });
    for (const anchor of layoutNotices(sizedAnchors, width, height)) {
      const visual = this.visuals.get(anchor.vehicleId)!;
      visual.element.style.setProperty("--vehicle-color", anchor.color);
      visual.element.style.setProperty("--notice-width", `${anchor.width}px`);
      visual.element.style.transform = `translate3d(${anchor.bubbleX}px, ${anchor.bubbleY}px, 0)`;
      visual.element.dataset.anchor = `${anchor.x.toFixed(2)},${anchor.y.toFixed(2)}`;
      visual.stem.setAttribute("x1", String(anchor.bubbleX));
      visual.stem.setAttribute("y1", String(anchor.bubbleY));
      visual.stem.setAttribute("x2", String(anchor.x));
      visual.stem.setAttribute("y2", String(anchor.y));
    }
    const deadline = active.length ? Math.min(...active.map(item => item.expiresAt)) : null;
    if (deadline !== this.deadline) {
      if (this.wakeup !== null) clearTimeout(this.wakeup);
      this.deadline = deadline;
      this.wakeup = deadline === null ? null : setTimeout(() => {
        this.wakeup = null; this.deadline = null; this.invalidate();
      }, Math.max(1, deadline - now));
    }
  }

  dispose() {
    if (this.wakeup !== null) clearTimeout(this.wakeup);
    this.board.reset();
    this.visuals.clear();
    this.layer.remove();
  }
}
