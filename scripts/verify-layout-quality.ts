/**
 * Standalone check for Phase 3's soft-constraint scorer against the real
 * fixture: an empty room, a reasonably furnished one, and a deliberately
 * sealed-off room (to confirm the reachability signal actually catches it).
 *
 * Run: npx ts-node scripts/verify-layout-quality.ts
 */
import fs from "fs";
import path from "path";
import { buildRoomGeometry, inspectRoom, RoomGeometry } from "../src/services/roomShellService";
import { resolveIntent, EntityLookup, ResolvedEntity } from "../src/services/placementSolverService";
import { scoreLayout, ScoredItem } from "../src/services/layoutQualityService";
import { PlacementIntent, RoomPlanCapturedRoom } from "../src/types/staging.types";

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  PASS: ${label}`);
  else {
    failures++;
    console.log(`  FAIL: ${label}${detail ? ` (${detail})` : ""}`);
  }
}

const fixturePath = path.join(__dirname, "..", "src", "services", "__fixtures__", "sample-scan.json");
const serialized = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as RoomPlanCapturedRoom;
const inspection = inspectRoom(serialized);
const geometry: RoomGeometry = buildRoomGeometry(serialized, inspection.room);
const floorY = inspection.room.bounds_min[1];

console.log("\n=== empty room ===");
const emptyResult = scoreLayout([], geometry);
console.log("  scores:", emptyResult.scores);
console.log("  critique:", emptyResult.critique);
check("empty room scores low on fill", emptyResult.scores.fill < 0.3, `fill=${emptyResult.scores.fill}`);
check("empty room has zero blocked_fraction", emptyResult.scores.blocked_fraction === 0);
check("empty room has good circulation (nothing to block it)", emptyResult.scores.circulation > 0.5, `circulation=${emptyResult.scores.circulation}`);

// --- a plausibly furnished room via the real solver -------------------------
console.log("\n=== solver-furnished room ===");
const fakeSlots = new Map<string, ResolvedEntity>();
const lookup: EntityLookup = { resolveFurniture: (id) => fakeSlots.get(id) ?? null, listAllPlaced: () => [...fakeSlots.values()] };
const openings = [...geometry.doors, ...geometry.windows];
const wideWalls = geometry.walls.filter((w) => !openings.some((o) => o.parentWallIdentifier === w.identifier) && w.widthM > 2);

const furnished: ScoredItem[] = [];
const placements: Array<{ dims: { widthM: number; heightM: number; depthM: number }; category: string }> = [
  { dims: { widthM: 1.6, heightM: 1.0, depthM: 0.8 }, category: "sofa" },
  { dims: { widthM: 0.5, heightM: 0.5, depthM: 0.5 }, category: "chair" },
  { dims: { widthM: 1.2, heightM: 0.5, depthM: 0.6 }, category: "storage" },
];
for (let i = 0; i < placements.length && i < wideWalls.length; i++) {
  const { dims, category } = placements[i];
  const intent: PlacementIntent = { anchor: { kind: "against_wall", wall_id: wideWalls[i].identifier } };
  const solved = resolveIntent(intent, dims, floorY, geometry, lookup);
  if (!solved.ok) continue;
  const item: ScoredItem = {
    key: `item_${i}`,
    position: solved.position,
    rotationYDegrees: solved.rotationYDegrees,
    widthM: dims.widthM,
    depthM: dims.depthM,
    category,
  };
  furnished.push(item);
  fakeSlots.set(item.key, { position: item.position, rotationYDegrees: item.rotationYDegrees, widthM: item.widthM, depthM: item.depthM });
}
check("placed at least a couple of items for this test", furnished.length >= 2, `placed=${furnished.length}`);

const furnishedResult = scoreLayout(furnished, geometry);
console.log("  scores:", furnishedResult.scores);
console.log("  critique:", furnishedResult.critique);
check("furnished room has higher fill than the empty room", furnishedResult.scores.fill > emptyResult.scores.fill);
check("furnished room still has reasonable circulation (not fully blocked)", furnishedResult.scores.circulation > 0.3, `circulation=${furnishedResult.scores.circulation}`);
check("overall score is a finite number in [0,1]", Number.isFinite(furnishedResult.scores.overall) && furnishedResult.scores.overall >= 0 && furnishedResult.scores.overall <= 1);

// --- sealed-off room: synthetic corridor, since a single blocker dropped
// anywhere in this real, wide apartment just gets routed around (a real
// negative test needs a full-width barrier, not just "a big item somewhere"). --
console.log("\n=== sealed-off room (reachability sanity check, synthetic corridor) ===");
const corridorGeometry: RoomGeometry = {
  walls: [],
  doors: [{ identifier: "door-synth", parentWallIdentifier: null, position: [0, floorY, -2.8], rotationYDegrees: 0, widthM: 0.9, heightM: 2.1 }],
  windows: [],
  wallBoxes: [],
  floorPolygon: [
    [-1, -3],
    [1, -3],
    [1, 3],
    [-1, 3],
  ],
  boundsMin: [-1, floorY, -3],
  boundsMax: [1, floorY + 2.4, 3],
};
const corridorEmpty = scoreLayout([], corridorGeometry);
const fullWidthBlocker: ScoredItem = { key: "barrier", position: [0, floorY, 0], rotationYDegrees: 0, widthM: 3, depthM: 0.3 };
const corridorSealed = scoreLayout([fullWidthBlocker], corridorGeometry);
console.log("  empty corridor scores:", corridorEmpty.scores);
console.log("  sealed corridor scores:", corridorSealed.scores);
check(
  "a full-width barrier partway down a corridor drops reachable floor area sharply",
  corridorSealed.scores.circulation < corridorEmpty.scores.circulation * 0.7,
  `sealed=${corridorSealed.scores.circulation} empty=${corridorEmpty.scores.circulation}`
);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
