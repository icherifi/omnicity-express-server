/**
 * Soft constraints: quality signals that steer Claude's critique but never block
 * finish_staging. All share one 10cm-cell grid over the floor polygon's bounding
 * box (built once per review_layout call), each cell tagged `inPolygon` (real
 * floor, via point-in-polygon - not just inside the bounding box) and `blocked`
 * (inside a placed item's footprint + a small clearance margin). A 4x5m room is
 * ~2000 cells - two BFS passes over that is sub-millisecond, no navmesh/
 * pathfinding library needed.
 */

import { floorCentroid, RoomGeometry } from "./roomShellService";
import { axesOf, dot, footprintCorners, length, polygonArea, pointInPolygon, sub, Vec2, xz } from "./geometry2d";
import { SoftScores } from "../types/staging.types";

const CELL_SIZE_M = 0.1;
const CLEARANCE_MARGIN_M = 0.05;
const TARGET_CORRIDOR_WIDTH_CM = 80;
const ACTIVITY_RADIUS_M = 1.5;
const TARGET_FOOTPRINT_RATIO_MIN = 0.25;
const TARGET_FOOTPRINT_RATIO_MAX = 0.45;
const SEATING_CATEGORIES = new Set(["chair", "sofa"]);
const FOCAL_CATEGORIES = new Set(["television", "fireplace"]);

const WEIGHTS = { circulation: 0.3, fill: 0.25, focal: 0.2, scale: 0.15 };

export interface ScoredItem {
  key: string;
  position: [number, number, number];
  rotationYDegrees: number;
  widthM: number;
  depthM: number;
  /** guessed_category, if known - drives the focal-point score's seating/focal
   * detection; items with no category just never count as either. */
  category?: string;
}

interface Grid {
  minX: number;
  minZ: number;
  cellSize: number;
  cols: number;
  rows: number;
  inPolygon: Uint8Array;
  blocked: Uint8Array;
  hasFurniture: Uint8Array;
}

function buildGrid(geometry: RoomGeometry, items: ScoredItem[]): Grid | null {
  const poly = geometry.floorPolygon;
  if (!poly || poly.length < 3) return null;

  const xs = poly.map((p) => p[0]);
  const zs = poly.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const cols = Math.max(1, Math.ceil((maxX - minX) / CELL_SIZE_M));
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / CELL_SIZE_M));
  const n = cols * rows;

  const inPolygon = new Uint8Array(n);
  const blocked = new Uint8Array(n);
  const hasFurniture = new Uint8Array(n);

  const cellCenter = (col: number, row: number): Vec2 => [minX + (col + 0.5) * CELL_SIZE_M, minZ + (row + 0.5) * CELL_SIZE_M];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (pointInPolygon(cellCenter(col, row), poly)) inPolygon[row * cols + col] = 1;
    }
  }

  const markCells = (item: ScoredItem, marginM: number, target: Uint8Array) => {
    const corners = footprintCorners(xz(item.position), item.rotationYDegrees, item.widthM + marginM * 2, item.depthM + marginM * 2);
    const cxs = corners.map((c) => c[0]);
    const czs = corners.map((c) => c[1]);
    const colStart = Math.max(0, Math.floor((Math.min(...cxs) - minX) / CELL_SIZE_M));
    const colEnd = Math.min(cols - 1, Math.ceil((Math.max(...cxs) - minX) / CELL_SIZE_M));
    const rowStart = Math.max(0, Math.floor((Math.min(...czs) - minZ) / CELL_SIZE_M));
    const rowEnd = Math.min(rows - 1, Math.ceil((Math.max(...czs) - minZ) / CELL_SIZE_M));
    for (let row = rowStart; row <= rowEnd; row++) {
      for (let col = colStart; col <= colEnd; col++) {
        if (pointInPolygon(cellCenter(col, row), corners)) target[row * cols + col] = 1;
      }
    }
  };

  for (const item of items) {
    markCells(item, CLEARANCE_MARGIN_M, blocked);
    markCells(item, 0, hasFurniture);
  }

  return { minX, minZ, cellSize: CELL_SIZE_M, cols, rows, inPolygon, blocked, hasFurniture };
}

/** Multi-source BFS over the grid - `isSource` seeds distance 0, expansion only
 * through cells `isPassable` accepts. Returns -1 for any cell never reached. */
function multiSourceBFS(grid: Grid, isSource: (idx: number) => boolean, isPassable: (idx: number) => boolean): Int32Array {
  const n = grid.cols * grid.rows;
  const dist = new Int32Array(n).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (isSource(i)) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const row = Math.floor(idx / grid.cols);
    const col = idx % grid.cols;
    const neighbors: [number, number][] = [
      [row - 1, col],
      [row + 1, col],
      [row, col - 1],
      [row, col + 1],
    ];
    for (const [nr, nc] of neighbors) {
      if (nr < 0 || nr >= grid.rows || nc < 0 || nc >= grid.cols) continue;
      const nIdx = nr * grid.cols + nc;
      if (dist[nIdx] !== -1 || !isPassable(nIdx)) continue;
      dist[nIdx] = dist[idx] + 1;
      queue.push(nIdx);
    }
  }
  return dist;
}

interface CirculationResult {
  score: number;
  minCorridorWidthCm: number;
  reachableFraction: number;
}

/**
 * Circulation score: a clearance-radius distance transform (BFS from every
 * blocked/boundary cell, expanding freely) gives each free cell its distance to
 * the nearest obstruction; a second BFS from the entry point (nearest free cell
 * to the first door, or the room centroid if there's no door), expanding only
 * through free cells, gives reachability. `reachable_fraction` catches an
 * arrangement that seals off part of the room; the minimum clearance among
 * REACHABLE cells approximates the narrowest bottleneck anywhere you can
 * actually walk - a simpler proxy than tracing a path to every furniture group
 * individually, in the same spirit.
 */
function scoreCirculation(grid: Grid, geometry: RoomGeometry): CirculationResult {
  const n = grid.cols * grid.rows;
  const isObstruction = (idx: number) => grid.blocked[idx] === 1 || grid.inPolygon[idx] === 0;
  const clearance = multiSourceBFS(grid, isObstruction, () => true);

  const entryXZ = geometry.doors.length > 0 ? xz(geometry.doors[0].position) : floorCentroid(geometry);
  let entryIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < n; i++) {
    if (grid.inPolygon[i] !== 1 || grid.blocked[i] === 1) continue;
    const row = Math.floor(i / grid.cols);
    const col = i % grid.cols;
    const cx = grid.minX + (col + 0.5) * grid.cellSize;
    const cz = grid.minZ + (row + 0.5) * grid.cellSize;
    const d = Math.hypot(cx - entryXZ[0], cz - entryXZ[1]);
    if (d < bestDist) {
      bestDist = d;
      entryIdx = i;
    }
  }
  if (entryIdx === -1) return { score: 0, minCorridorWidthCm: 0, reachableFraction: 0 };

  const isPassable = (idx: number) => grid.inPolygon[idx] === 1 && grid.blocked[idx] === 0;
  const reach = multiSourceBFS(grid, (i) => i === entryIdx, isPassable);

  let totalFree = 0;
  const reachableClearances: number[] = [];
  // A room with literally no obstruction anywhere in the grid (an empty room
  // whose floor polygon happens to exactly match its own bounding box, leaving
  // no "outside" cells to seed the obstruction BFS from) leaves clearance[i] at
  // -1 ("never reached") for every cell, not because it's unsafe but because
  // there's nothing to be close to - treat that as maximally clear, not as a
  // literal -1 cell distance leaking into the score as a negative width.
  const noObstructionFallback = grid.cols + grid.rows;
  for (let i = 0; i < n; i++) {
    if (grid.inPolygon[i] !== 1 || grid.blocked[i] === 1) continue;
    totalFree++;
    if (reach[i] !== -1) reachableClearances.push(clearance[i] === -1 ? noObstructionFallback : clearance[i]);
  }

  const reachableFraction = totalFree > 0 ? reachableClearances.length / totalFree : 0;
  // The single narrowest cell is a poor bottleneck proxy: some free cell is
  // always within one grid cell of the room's own perimeter wall regardless of
  // furniture, so a strict minimum is ~1 cell in literally every room, furnished
  // or not - it never actually responds to anything. A low percentile instead
  // ignores that thin, unavoidable wall-hugging fringe while still catching a
  // passage that's narrow across a meaningful stretch of the reachable area.
  reachableClearances.sort((a, b) => a - b);
  const percentileIdx = Math.floor(reachableClearances.length * 0.15);
  const bottleneckClearanceCells = reachableClearances.length > 0 ? reachableClearances[percentileIdx] : 0;
  // Clearance is a radius to the nearest obstruction; a corridor's actual width
  // is roughly twice that (obstructions on both sides).
  const minCorridorWidthCm = bottleneckClearanceCells * grid.cellSize * 100 * 2;
  const widthScore = Math.min(1, minCorridorWidthCm / TARGET_CORRIDOR_WIDTH_CM);
  return { score: reachableFraction * widthScore, minCorridorWidthCm, reachableFraction };
}

interface FillResult {
  fillScore: number;
  blockedFraction: number;
}

/** Dead-space/fill: a second BFS, this time from furniture cells, gives every
 * free cell its distance to the nearest piece of furniture. fill_score is the
 * fraction of free floor within a plausible "activity radius" of something;
 * blocked_fraction (how much of the room's floor is furniture footprint at all)
 * is reported alongside so the critique can tell "too empty" from "too
 * cramped" - a low fill score with a high blocked_fraction is a packed room
 * with poor circulation, not a sparse one. */
function scoreFill(grid: Grid): FillResult {
  const n = grid.cols * grid.rows;
  const isFurniture = (idx: number) => grid.hasFurniture[idx] === 1;
  const furnitureDist = multiSourceBFS(grid, isFurniture, () => true);

  const radiusCells = ACTIVITY_RADIUS_M / grid.cellSize;
  let totalFree = 0;
  let blockedCount = 0;
  let nearFurniture = 0;
  for (let i = 0; i < n; i++) {
    if (grid.inPolygon[i] !== 1) continue;
    if (grid.blocked[i] === 1) {
      blockedCount++;
      continue;
    }
    totalFree++;
    if (furnitureDist[i] !== -1 && furnitureDist[i] <= radiusCells) nearFurniture++;
  }
  const totalInPolygon = totalFree + blockedCount;
  return {
    fillScore: totalFree > 0 ? nearFurniture / totalFree : 0,
    blockedFraction: totalInPolygon > 0 ? blockedCount / totalInPolygon : 0,
  };
}

/** Average cosine of (seat's facing direction) . (direction to the focal point)
 * across every seating item - 1 means every seat faces the TV/fireplace/window
 * exactly, 0 or negative means seats face away/sideways. Returns null (never a
 * fabricated 0) when there's no seating or no plausible focal point at all -
 * omitted from the critique rather than reported as a bad score for something
 * that was never applicable. */
function scoreFocalPoint(items: ScoredItem[], geometry: RoomGeometry): number | null {
  const seating = items.filter((i) => i.category && SEATING_CATEGORIES.has(i.category));
  if (seating.length === 0) return null;

  const focalItem = items.find((i) => i.category && FOCAL_CATEGORIES.has(i.category));
  const focalXZ = focalItem ? xz(focalItem.position) : geometry.windows.length > 0 ? xz(geometry.windows[0].position) : null;
  if (!focalXZ) return null;

  let sum = 0;
  for (const seat of seating) {
    const { forward } = axesOf(seat.rotationYDegrees);
    const toFocal = sub(focalXZ, xz(seat.position));
    const d = length(toFocal);
    if (d < 1e-6) continue;
    sum += Math.max(0, dot(forward, [toFocal[0] / d, toFocal[1] / d]));
  }
  return sum / seating.length;
}

/** Total furniture footprint vs. floor area, scored against a 25-45% occupancy
 * band - degrades linearly outside it. Deliberately blind to WHERE items are
 * (that's circulation/fill's job): three sofas clumped in one corner of a big
 * room can score fine here while scoring terribly on circulation/fill, and that
 * split is intentional - the two catch different failure modes. */
function scoreScale(items: ScoredItem[], geometry: RoomGeometry): number {
  if (!geometry.floorPolygon || geometry.floorPolygon.length < 3) return 0.5;
  const floorArea = polygonArea(geometry.floorPolygon);
  if (floorArea <= 0) return 0.5;
  const itemsArea = items.reduce((s, i) => s + i.widthM * i.depthM, 0);
  const ratio = itemsArea / floorArea;
  if (ratio < TARGET_FOOTPRINT_RATIO_MIN) return ratio / TARGET_FOOTPRINT_RATIO_MIN;
  if (ratio > TARGET_FOOTPRINT_RATIO_MAX) return Math.max(0, 1 - (ratio - TARGET_FOOTPRINT_RATIO_MAX) / TARGET_FOOTPRINT_RATIO_MAX);
  return 1;
}

function buildCritique(scores: SoftScores, circ: CirculationResult): string {
  const notes: string[] = [];
  if (scores.circulation < 0.5) {
    notes.push(
      `Circulation faible (${scores.circulation.toFixed(2)}) - le passage le plus étroit atteignable depuis l'entrée fait environ ${circ.minCorridorWidthCm.toFixed(0)}cm de large${
        circ.reachableFraction < 0.9 ? ", et une partie de la pièce n'est pas atteignable" : ""
      }.`
    );
  }
  if (scores.fill < 0.4) {
    notes.push(`Remplissage faible (${scores.fill.toFixed(2)}) - de grandes zones du sol ne sont proches d'aucun meuble, la pièce peut sembler vide.`);
  }
  if (scores.blocked_fraction > 0.5) {
    notes.push(`Pièce encombrée (${(scores.blocked_fraction * 100).toFixed(0)}% du sol occupé par du mobilier) - envisage de retirer ou réduire certains meubles.`);
  }
  if (scores.focal_point !== null && scores.focal_point < 0.4) {
    notes.push(`Les sièges ne sont pas bien orientés vers un point focal (score ${scores.focal_point.toFixed(2)}).`);
  }
  if (scores.scale < 0.6) {
    notes.push(`Échelle du mobilier par rapport à la pièce déséquilibrée (score ${scores.scale.toFixed(2)}).`);
  }
  if (notes.length === 0) return `Agencement globalement satisfaisant (score global ${scores.overall.toFixed(2)}).`;
  return `Score global ${scores.overall.toFixed(2)}. Points à améliorer :\n${notes.map((n) => `- ${n}`).join("\n")}`;
}

export function scoreLayout(items: ScoredItem[], geometry: RoomGeometry): { scores: SoftScores; critique: string } {
  const grid = buildGrid(geometry, items);
  if (!grid) {
    const neutral: SoftScores = { circulation: 0.5, fill: 0.5, blocked_fraction: 0, focal_point: null, scale: 0.5, overall: 0.5 };
    return { scores: neutral, critique: "Pas de polygone de sol disponible pour ce scan - scores qualité non calculables." };
  }

  const circ = scoreCirculation(grid, geometry);
  const fill = scoreFill(grid);
  const focal = scoreFocalPoint(items, geometry);
  const scale = scoreScale(items, geometry);

  const focalWeight = focal !== null ? WEIGHTS.focal : 0;
  const totalWeight = WEIGHTS.circulation + WEIGHTS.fill + WEIGHTS.scale + focalWeight;
  const overall =
    (circ.score * WEIGHTS.circulation + fill.fillScore * WEIGHTS.fill + (focal ?? 0) * focalWeight + scale * WEIGHTS.scale) / totalWeight;

  const scores: SoftScores = {
    circulation: circ.score,
    fill: fill.fillScore,
    blocked_fraction: fill.blockedFraction,
    focal_point: focal,
    scale,
    overall,
  };

  return { scores, critique: buildCritique(scores, circ) };
}
