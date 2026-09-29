/**
 * Splits a floor into functional zones (bedroom/kitchen/bathroom/living/generic)
 * so a furniture manifest can be assigned per zone instead of per whole-apartment
 * scan. RoomPlan's own `sections[]` are NOT enough on their own: each is just a
 * single labeled point with no size/extent, and can be geometrically far from
 * the real functional area it should label. A Voronoi-style partition (assign
 * each floor cell to its nearest section) plus a furniture-category label
 * refinement closes that gap, while still degrading gracefully to one generic
 * zone on a scan with no sections and no furniture at all.
 */

import { RoomGeometry, Zone } from "./roomShellService";
import { pointInPolygon, polygonArea, Vec2 } from "./geometry2d";
import { DetectedObject, RoomSection } from "../types/staging.types";

const CELL_SIZE_M = 0.2;
const MIN_ZONE_CELLS = 9;

/** Raw RoomPlan section labels this app has ever seen (or that Apple's RoomPlan
 * API is known to emit) normalized to the closed label set every downstream
 * consumer (manifests, zone_center anchors) can rely on. Anything unrecognized -
 * including RoomPlan's own "unidentified" - becomes "generic" rather than a
 * long tail of one-off strings; the furniture-category refinement pass below is
 * what actually resolves a "generic" label when there's evidence to do so. */
function normalizeRawLabel(rawLabel: string): string {
  const key = rawLabel.toLowerCase();
  if (key === "bedroom") return "bedroom";
  if (key === "kitchen") return "kitchen";
  if (key === "bathroom") return "bathroom";
  if (key === "livingroom" || key === "living" || key === "diningroom" || key === "dining" || key === "familyroom") return "living";
  return "generic";
}

/** Categories that vote for a zone's label when refining it from furniture
 * evidence. Deliberately excludes "storage" (a RoomPlan "cabinet" is the same
 * raw category whether it's a bedroom wardrobe or a kitchen base unit - not a
 * reliable signal either way) and "table"/"chair" (too ambiguous - dining,
 * coffee, desk, or kitchen table all share the same category). */
const CATEGORY_VOTES: Record<string, string> = {
  bed: "bedroom",
  sofa: "living",
  television: "living",
  sink: "kitchen",
  stove: "kitchen",
  oven: "kitchen",
  refrigerator: "kitchen",
  washerDryer: "kitchen",
  dishwasher: "kitchen",
  toilet: "bathroom",
  bathtub: "bathroom",
};

interface Grid {
  minX: number;
  minZ: number;
  cols: number;
  rows: number;
  inPolygon: Uint8Array;
  /** -1 = not yet assigned to a section/zone. */
  sectionIndex: Int32Array;
  zoneIndex: Int32Array;
}

function cellCenter(grid: Grid, col: number, row: number): Vec2 {
  return [grid.minX + (col + 0.5) * CELL_SIZE_M, grid.minZ + (row + 0.5) * CELL_SIZE_M];
}

function buildGrid(floorPolygon: Vec2[]): Grid {
  const xs = floorPolygon.map((p) => p[0]);
  const zs = floorPolygon.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const cols = Math.max(1, Math.ceil((maxX - minX) / CELL_SIZE_M));
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / CELL_SIZE_M));
  const n = cols * rows;
  const grid: Grid = {
    minX,
    minZ,
    cols,
    rows,
    inPolygon: new Uint8Array(n),
    sectionIndex: new Int32Array(n).fill(-1),
    zoneIndex: new Int32Array(n).fill(-1),
  };
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (pointInPolygon(cellCenter(grid, col, row), floorPolygon)) grid.inPolygon[row * cols + col] = 1;
    }
  }
  return grid;
}

/** Discrete Voronoi partition: every in-polygon cell gets the index of its
 * nearest section center (planar distance) - trivially cheap, single digits of
 * generators against a couple thousand cells.
 *
 * A cell farther than SECTION_CLAIM_RADIUS_M from every section is left
 * UNCLAIMED rather than force-assigned to whatever section happens to be
 * least-far: without a cap, a real furniture cluster far from every section
 * could get Voronoi-sliced across multiple wrong zones if different parts
 * are marginally closer to different sections - label refinement can't undo
 * a physical area that was wrongly split in the first place. Unclaimed cells
 * instead form their own connected components below, labeled purely from
 * furniture-category evidence. */
const UNCLAIMED = -2;
const SECTION_CLAIM_RADIUS_M = 2.5;

function assignNearestSection(grid: Grid, sections: RoomSection[]) {
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const idx = row * grid.cols + col;
      if (grid.inPolygon[idx] !== 1) continue;
      const [cx, cz] = cellCenter(grid, col, row);
      let best = UNCLAIMED;
      let bestDist = SECTION_CLAIM_RADIUS_M;
      for (let s = 0; s < sections.length; s++) {
        const d = Math.hypot(cx - sections[s].center[0], cz - sections[s].center[2]);
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      }
      grid.sectionIndex[idx] = best;
    }
  }
}

/** Connected components (4-neighbor flood fill) among cells sharing the same
 * section assignment - one zone per contiguous region, NOT one per label. This
 * is what makes two same-labeled sections (two "bedroom" sections in a
 * multi-bedroom apartment) naturally produce two separate zones, and what
 * correctly splits one section's Voronoi cell into two if a concave floor shape
 * separates them into disconnected islands. */
function floodFillZones(grid: Grid): number {
  let zoneCount = 0;
  for (let start = 0; start < grid.cols * grid.rows; start++) {
    if (grid.inPolygon[start] !== 1 || grid.zoneIndex[start] !== -1) continue;
    const sectionIdx = grid.sectionIndex[start];
    const queue = [start];
    grid.zoneIndex[start] = zoneCount;
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
        if (grid.inPolygon[nIdx] !== 1 || grid.zoneIndex[nIdx] !== -1 || grid.sectionIndex[nIdx] !== sectionIdx) continue;
        grid.zoneIndex[nIdx] = zoneCount;
        queue.push(nIdx);
      }
    }
    zoneCount++;
  }
  return zoneCount;
}

function singleGenericZone(geometry: RoomGeometry): { zones: Zone[]; objectZoneAssignments: Map<string, string> } {
  const boundsMin: Vec2 = [geometry.boundsMin[0], geometry.boundsMin[2]];
  const boundsMax: Vec2 = [geometry.boundsMax[0], geometry.boundsMax[2]];
  const centroid: Vec2 = [(boundsMin[0] + boundsMax[0]) / 2, (boundsMin[1] + boundsMax[1]) / 2];
  const area = geometry.floorPolygon && geometry.floorPolygon.length >= 3 ? polygonArea(geometry.floorPolygon) : (boundsMax[0] - boundsMin[0]) * (boundsMax[1] - boundsMin[1]);
  return {
    zones: [{ id: "zone_generic_1", label: "generic", centroid, area_m2: area, bounds_min: boundsMin, bounds_max: boundsMax }],
    objectZoneAssignments: new Map(),
  };
}

export function classifyZones(
  geometry: RoomGeometry,
  sections: RoomSection[],
  objects: DetectedObject[]
): { zones: Zone[]; objectZoneAssignments: Map<string, string> } {
  if (sections.length === 0 || !geometry.floorPolygon || geometry.floorPolygon.length < 3) {
    return singleGenericZone(geometry);
  }

  const grid = buildGrid(geometry.floorPolygon);
  assignNearestSection(grid, sections);
  const rawZoneCount = floodFillZones(grid);

  // Per raw (pre-noise-filter) zone index: cell count, running centroid sum, bbox.
  const cellCounts = new Array(rawZoneCount).fill(0);
  const centroidSums: Vec2[] = Array.from({ length: rawZoneCount }, () => [0, 0]);
  const boundsMins: Vec2[] = Array.from({ length: rawZoneCount }, () => [Infinity, Infinity]);
  const boundsMaxs: Vec2[] = Array.from({ length: rawZoneCount }, () => [-Infinity, -Infinity]);
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const idx = row * grid.cols + col;
      const z = grid.zoneIndex[idx];
      if (z === -1) continue;
      const [cx, cz] = cellCenter(grid, col, row);
      cellCounts[z]++;
      centroidSums[z][0] += cx;
      centroidSums[z][1] += cz;
      boundsMins[z][0] = Math.min(boundsMins[z][0], cx);
      boundsMins[z][1] = Math.min(boundsMins[z][1], cz);
      boundsMaxs[z][0] = Math.max(boundsMaxs[z][0], cx);
      boundsMaxs[z][1] = Math.max(boundsMaxs[z][1], cz);
    }
  }

  // Drop noise-sized components, remap surviving raw indices to dense 0..N-1.
  const rawToFinal = new Map<number, number>();
  for (let z = 0; z < rawZoneCount; z++) {
    if (cellCounts[z] >= MIN_ZONE_CELLS) rawToFinal.set(z, rawToFinal.size);
  }
  if (rawToFinal.size === 0) return singleGenericZone(geometry);

  const cellAreaM2 = CELL_SIZE_M * CELL_SIZE_M;
  const finalCentroids: Vec2[] = [];
  const finalAreas: number[] = [];
  const finalBoundsMin: Vec2[] = [];
  const finalBoundsMax: Vec2[] = [];
  const finalRawLabel: string[] = [];
  for (const [rawIdx, finalIdx] of rawToFinal) {
    finalCentroids[finalIdx] = [centroidSums[rawIdx][0] / cellCounts[rawIdx], centroidSums[rawIdx][1] / cellCounts[rawIdx]];
    finalAreas[finalIdx] = cellCounts[rawIdx] * cellAreaM2;
    finalBoundsMin[finalIdx] = boundsMins[rawIdx];
    finalBoundsMax[finalIdx] = boundsMaxs[rawIdx];
    const anyCell = findAnyCellForZone(grid, rawIdx);
    const sectionIdx = grid.sectionIndex[anyCell];
    finalRawLabel[finalIdx] = normalizeRawLabel(sections[sectionIdx]?.label ?? "");
  }

  // objectZoneAssignments: nearest-cell lookup. An object whose own cell isn't
  // in-polygon (near a wall, or outside the grid) does an expanding-radius
  // search over nearby cells rather than jumping to the nearest zone's
  // centroid - an object right beside a zone's boundary is more likely to
  // belong to that nearby zone than to whichever zone's center of mass is
  // technically closest.
  const objectZoneAssignments = new Map<string, string>();
  const objectFinalIndex = new Map<string, number>();
  const MAX_SEARCH_RADIUS_CELLS = 10;
  for (const obj of objects) {
    const [ox, oz] = [obj.position[0], obj.position[2]];
    const col = Math.max(0, Math.min(grid.cols - 1, Math.floor((ox - grid.minX) / CELL_SIZE_M)));
    const row = Math.max(0, Math.min(grid.rows - 1, Math.floor((oz - grid.minZ) / CELL_SIZE_M)));

    let finalIdx: number | undefined;
    for (let radius = 0; finalIdx === undefined && radius <= MAX_SEARCH_RADIUS_CELLS; radius++) {
      let bestDist = Infinity;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue; // only the new ring at this radius
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || r >= grid.rows || c < 0 || c >= grid.cols) continue;
          const cellZone = grid.zoneIndex[r * grid.cols + c];
          if (cellZone === -1) continue;
          const candidate = rawToFinal.get(cellZone);
          if (candidate === undefined) continue;
          const [cx, cz] = cellCenter(grid, c, r);
          const d = Math.hypot(ox - cx, oz - cz);
          if (d < bestDist) {
            bestDist = d;
            finalIdx = candidate;
          }
        }
      }
    }
    if (finalIdx !== undefined) objectFinalIndex.set(obj.object_name, finalIdx);
  }

  // Label refinement from furniture-category votes.
  const votesByZone: Array<Map<string, number>> = finalCentroids.map(() => new Map());
  for (const obj of objects) {
    const finalIdx = objectFinalIndex.get(obj.object_name);
    const vote = CATEGORY_VOTES[obj.guessed_category];
    if (finalIdx === undefined || !vote) continue;
    const votes = votesByZone[finalIdx];
    votes.set(vote, (votes.get(vote) ?? 0) + 1);
  }

  const finalLabels: string[] = finalRawLabel.map((rawLabel, i) => refineLabel(rawLabel, votesByZone[i]));

  const idCounters = new Map<string, number>();
  const zoneIds: string[] = finalLabels.map((label) => {
    const n = (idCounters.get(label) ?? 0) + 1;
    idCounters.set(label, n);
    return `zone_${label}_${n}`;
  });

  const zones: Zone[] = finalLabels.map((label, i) => ({
    id: zoneIds[i],
    label,
    centroid: finalCentroids[i],
    area_m2: finalAreas[i],
    bounds_min: finalBoundsMin[i],
    bounds_max: finalBoundsMax[i],
  }));

  for (const [objectName, finalIdx] of objectFinalIndex) {
    objectZoneAssignments.set(objectName, zoneIds[finalIdx]);
  }

  return mergeOrphanZones(zones, objectZoneAssignments);
}

/** A small zone that never got refined away from "generic" is usually a
 * leftover pocket of a neighboring room, not its own functional space (e.g. a
 * small chair+table nook next to a bedroom - neither category votes for a
 * label, so refineLabel alone can't fix it). Absorbing it into whichever
 * labeled zone it borders is a geometric fix instead of a labeling one. An
 * orphan with no labeled neighbor (a genuinely standalone small room) is left
 * as its own zone, still getting a compact manifest. */
const SMALL_ORPHAN_ZONE_AREA_M2 = 8;
const ZONE_ADJACENCY_MARGIN_M = 0.5;

function boundsOverlapOrAdjacent(aMin: Vec2, aMax: Vec2, bMin: Vec2, bMax: Vec2, marginM: number): boolean {
  return aMin[0] <= bMax[0] + marginM && aMax[0] >= bMin[0] - marginM && aMin[1] <= bMax[1] + marginM && aMax[1] >= bMin[1] - marginM;
}

function mergeOrphanZones(
  zones: Zone[],
  objectZoneAssignments: Map<string, string>
): { zones: Zone[]; objectZoneAssignments: Map<string, string> } {
  const remap = new Map<string, string>();
  const merged = new Map<string, Zone>(zones.map((z) => [z.id, { ...z }]));

  for (const orphan of zones) {
    if (orphan.label !== "generic" || orphan.area_m2 > SMALL_ORPHAN_ZONE_AREA_M2) continue;

    let bestNeighbor: Zone | null = null;
    let bestDist = Infinity;
    for (const other of zones) {
      if (other.id === orphan.id || other.label === "generic") continue;
      if (!boundsOverlapOrAdjacent(orphan.bounds_min, orphan.bounds_max, other.bounds_min, other.bounds_max, ZONE_ADJACENCY_MARGIN_M)) continue;
      const d = Math.hypot(orphan.centroid[0] - other.centroid[0], orphan.centroid[1] - other.centroid[1]);
      if (d < bestDist) {
        bestDist = d;
        bestNeighbor = other;
      }
    }
    if (!bestNeighbor) continue;

    const target = merged.get(bestNeighbor.id)!;
    target.bounds_min = [Math.min(target.bounds_min[0], orphan.bounds_min[0]), Math.min(target.bounds_min[1], orphan.bounds_min[1])];
    target.bounds_max = [Math.max(target.bounds_max[0], orphan.bounds_max[0]), Math.max(target.bounds_max[1], orphan.bounds_max[1])];
    target.area_m2 += orphan.area_m2;
    merged.delete(orphan.id);
    remap.set(orphan.id, bestNeighbor.id);
  }

  if (remap.size === 0) return { zones, objectZoneAssignments };
  const newAssignments = new Map([...objectZoneAssignments].map(([obj, zoneId]) => [obj, remap.get(zoneId) ?? zoneId] as const));
  return { zones: [...merged.values()], objectZoneAssignments: newAssignments };
}

function findAnyCellForZone(grid: Grid, rawZoneIndex: number): number {
  for (let i = 0; i < grid.zoneIndex.length; i++) {
    if (grid.zoneIndex[i] === rawZoneIndex) return i;
  }
  return 0;
}

/** Overrides the raw RoomPlan section label with the furniture-vote winner only
 * when: the section is unlabeled ("generic") and there's any evidence at all, OR
 * the section label and the furniture evidence disagree outright with >=2
 * qualifying objects (avoids flipping a real "bedroom" section to "living" over
 * one stray sofa-shaped false positive). */
function refineLabel(rawLabel: string, votes: Map<string, number>): string {
  if (votes.size === 0) return rawLabel;
  let topLabel = rawLabel;
  let topCount = 0;
  for (const [label, count] of votes) {
    if (count > topCount) {
      topCount = count;
      topLabel = label;
    }
  }
  if (rawLabel === "generic") return topCount >= 1 ? topLabel : "generic";
  if (topLabel !== rawLabel && topCount >= 2) return topLabel;
  return rawLabel;
}
