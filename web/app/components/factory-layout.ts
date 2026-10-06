import type { GridPoint, MazeScenario } from "./maze-model";

export type FactoryFixture = GridPoint & { kind: "rack" | "machine"; variant: number };

/** Fixtures occupy exactly the simulator's blocked cells, never a free aisle. */
export function factoryFixtures(scenario: MazeScenario): FactoryFixture[] {
  const key = ({ x, y }: GridPoint) => `${x}:${y}`;
  const remaining = new Map(scenario.obstacles.map((point) => [key(point), point]));
  const pairedKinds = new Map<string, FactoryFixture["kind"]>();
  for (const first of scenario.obstacles) {
    if (!remaining.delete(key(first))) continue;
    const bank = [first];
    for (let index = 0; index < bank.length; index++) {
      const point = bank[index];
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const neighborKey = `${point.x + dx}:${point.y + dy}`;
        const neighbor = remaining.get(neighborKey);
        if (!neighbor) continue;
        remaining.delete(neighborKey);
        bank.push(neighbor);
      }
    }
    const minX = Math.min(...bank.map(({ x }) => x)), maxX = Math.max(...bank.map(({ x }) => x));
    const minY = Math.min(...bank.map(({ y }) => y)), maxY = Math.max(...bank.map(({ y }) => y));
    const columns = maxX - minX + 1, rows = maxY - minY + 1;
    if (bank.length !== columns * rows || Math.min(columns, rows) !== 2) continue;
    const horizontal = rows === 2;
    for (const point of bank) {
      const anchor = horizontal ? { x: point.x, y: minY } : { x: minX, y: point.y };
      const atEnd = horizontal ? point.x === minX || point.x === maxX : point.y === minY || point.y === maxY;
      // Keep both shelves in each pair together. Equipment cabinets may occupy
      // an end pair, but never split a rack pair or interrupt the middle of a bank.
      const machinePair = atEnd && (anchor.x * 7 + anchor.y * 11) % 19 < 3;
      pairedKinds.set(key(point), machinePair ? "machine" : "rack");
    }
  }
  return scenario.obstacles.map((point) => {
    const variant = (point.x * 7 + point.y * 11) % 19;
    return { ...point, kind: pairedKinds.get(key(point)) ?? (variant < 3 ? "machine" : "rack"), variant };
  });
}

/** Paint only the exposed edges, so joined rack bays read as a single island. */
export function safetyEdges(scenario: MazeScenario) {
  const occupied = new Set(scenario.obstacles.map(({ x, y }) => `${x}:${y}`));
  const edges: { center: GridPoint; horizontal: boolean }[] = [];
  for (const point of scenario.obstacles) {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const x = point.x + dx, y = point.y + dy;
      if (x < 0 || y < 0 || x >= scenario.width || y >= scenario.height || occupied.has(`${x}:${y}`)) continue;
      edges.push({ center: { x: point.x + dx * 0.48, y: point.y + dy * 0.48 }, horizontal: dy !== 0 });
    }
  }
  return edges;
}
