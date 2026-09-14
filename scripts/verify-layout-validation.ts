/**
 * Standalone check for Phase 3's hard-constraint battery against the real
 * fixture: each of the 6 constraints, and the hybrid correction policy.
 *
 * Run: npx ts-node scripts/verify-layout-validation.ts
 */
import fs from "fs";
import path from "path";
import { buildRoomGeometry, buildWallCollisionBoxes, inspectRoom, wallInwardDirection, RoomGeometry } from "../src/services/roomShellService";
import { resolveIntent, EntityLookup, ResolvedEntity } from "../src/services/placementSolverService";
import { validateAndMaybeCorrect, validateAllPlacements, Footprint, OtherFootprint } from "../src/services/layoutValidationService";
import { LocalBoundingBox } from "../src/services/glbGeometryService";
import { PlacementIntent, RoomPlanCapturedRoom, RoomPlanEntity } from "../src/types/staging.types";

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

const fakeSlots = new Map<string, ResolvedEntity>();
const lookup: EntityLookup = { resolveFurniture: (id) => fakeSlots.get(id) ?? null, listAllPlaced: () => [...fakeSlots.values()] };

function boxFor(widthM: number, heightM: number, depthM: number): LocalBoundingBox {
  return { min: [-widthM / 2, -heightM / 2, -depthM / 2], max: [widthM / 2, heightM / 2, depthM / 2] };
}

function footprintAt(position: [number, number, number], rotationYDegrees: number, w: number, h: number, d: number): Footprint {
  return { localBox: boxFor(w, h, d), position, rotationYDegrees, widthM: w, heightM: h, depthM: d };
}

// --- solver + validator agreement -------------------------------------------
console.log("\n=== solver output passes validation ===");
const openings = [...geometry.doors, ...geometry.windows];
const cleanWall = geometry.walls.find((w) => !openings.some((o) => o.parentWallIdentifier === w.identifier) && w.widthM > 2);
if (cleanWall) {
  const intent: PlacementIntent = { anchor: { kind: "against_wall", wall_id: cleanWall.identifier } };
  const solved = resolveIntent(intent, { widthM: 1.6, heightM: 1.0, depthM: 0.8 }, floorY, geometry, lookup);
  check("solver succeeded for sanity setup", solved.ok);
  if (solved.ok) {
    const footprint = footprintAt(solved.position, solved.rotationYDegrees, 1.6, 1.0, 0.8);
    const result = validateAndMaybeCorrect(footprint, [], geometry);
    console.log("  validation result:", result);
    check("a solver-resolved against_wall placement passes all hard constraints untouched", result.ok && !result.corrected, JSON.stringify(result.violations));
  }
}

// --- wall penetration + single-violation auto-correction --------------------
console.log("\n=== wall_penetration + auto-correction (synthetic minimal room) ===");
// This fixture's real corridor is dense enough that virtually every wall spot
// also falls inside some door's clear zone or crosses outside the floor polygon -
// fine for the fixture, but it means there's no naturally-occurring spot to unit-
// test the CORRECTION MECHANISM in true isolation. Build a trivial synthetic room
// instead: one wall at one edge of a rectangular floor, no doors/windows.
const syntheticWallEntity: RoomPlanEntity = {
  identifier: "wall-synthetic",
  category: { wall: {} },
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, floorY, -3, 1],
  dimensions: [4, 2.4, 0],
};
const syntheticRoom = {
  bounds_min: [-2, floorY, -3] as [number, number, number],
  bounds_max: [2, floorY + 2.4, 3] as [number, number, number],
  wall_object_names: [syntheticWallEntity.identifier],
  floor_object_names: [],
  ceiling_object_names: [],
  floor_polygons: [
    [
      [-2, -3],
      [2, -3],
      [2, 3],
      [-2, 3],
    ] as [number, number][],
  ],
};
const syntheticGeometry: RoomGeometry = {
  walls: [{ identifier: syntheticWallEntity.identifier, position: [0, floorY, -3], rotationYDegrees: 0, widthM: 4, heightM: 2.4 }],
  doors: [],
  windows: [],
  wallBoxes: buildWallCollisionBoxes([syntheticWallEntity], syntheticRoom),
  floorPolygon: syntheticRoom.floor_polygons[0],
  boundsMin: syntheticRoom.bounds_min,
  boundsMax: syntheticRoom.bounds_max,
  zones: [],
};

const inward = wallInwardDirection(syntheticGeometry.walls[0], syntheticGeometry);
check("synthetic wall's inward direction resolves", inward !== null, JSON.stringify(inward));
if (inward) {
  const badPos: [number, number, number] = [inward[0] * 0.05, floorY, -3 + inward[1] * 0.05];
  const dims: [number, number, number] = [0.3, 0.5, 0.2];
  const result = validateAndMaybeCorrect(footprintAt(badPos, 0, ...dims), [], syntheticGeometry);
  console.log("  result:", result);
  // Whether the single triggered violation reads as wall_penetration or
  // floor_polygon depends on exact volumes/thresholds at this boundary spot -
  // both are "at the edge" checks and either is a valid isolated single
  // violation for exercising the correction mechanism itself.
  check(
    "item placed on the wall's plane gets auto-corrected (single isolated violation)",
    result.ok && result.corrected && (result.correction_reason === "wall_penetration" || result.correction_reason === "floor_polygon")
  );
  if (result.ok) {
    const recheck = validateAndMaybeCorrect(footprintAt(result.position, result.rotation_y_degrees, ...dims), [], syntheticGeometry);
    check("the corrected position itself is clean on re-validation", recheck.ok && !recheck.corrected);
  }
}


// A straddling-an-exterior-wall placement should instead be a correctly-rejected
// multi-violation case (documents the expected behavior, not a bug).
if (cleanWall) {
  const straddling = footprintAt([cleanWall.position[0], floorY, cleanWall.position[2]], cleanWall.rotationYDegrees, 0.6, 0.8, 0.4);
  const result = validateAndMaybeCorrect(straddling, [], geometry);
  check(
    "straddling an EXTERIOR wall is correctly left as an uncorrected multi-violation reject",
    !result.ok && result.violations.length >= 2
  );
}

// --- furniture overlap -------------------------------------------------------
console.log("\n=== furniture_overlap ===");
const other: OtherFootprint = { key: "existing_item", localBox: boxFor(1, 1, 1), position: [0, floorY, 0], rotationYDegrees: 0 };
const overlapping = footprintAt([0.1, floorY, 0.1], 0, 1, 1, 1);
const overlapResult = validateAndMaybeCorrect(overlapping, [other], geometry);
check("directly overlapping item is flagged (or auto-corrected away)", overlapResult.corrected || !overlapResult.ok);
if (!overlapResult.ok) check("...specifically as furniture_overlap", overlapResult.violations.some((v) => v.constraint === "furniture_overlap"));

// --- relaxed furniture-overlap threshold (allowedOverlapTargetId) -----------
// The mechanism a dining chair uses to intentionally tuck under its own
// table (see roomManifests.ts's DINING_CHAIR_TUCK_GAP_CM) without that
// deliberate overlap reading as a hard-constraint violation - but ONLY for
// the declared pair, never a blanket loophole. Uses the synthetic room above
// (empty except for one distant wall) rather than the real fixture, so
// nothing besides furniture_overlap can possibly fire near its center.
console.log("\n=== relaxed furniture-overlap threshold (allowedOverlapTargetId) ===");
const tableFootprint: OtherFootprint = { key: "table_1", localBox: boxFor(1, 1, 1), position: [0, floorY, 0], rotationYDegrees: 0 };

// Two 1x1x1 boxes centered `x` apart overlap along that axis by (1 - x) -
// e.g. x=0.94 -> 0.06m^3 overlap (roughly the real dining-chair tuck), x=0.85
// -> 0.15m^3. Solving for the offset instead of guessing keeps the intended
// volume exact.
const moderateOverlapChair = footprintAt([0.94, floorY, 0], 0, 1, 1, 1); // 0.06 m^3: above strict (0.01), below relaxed (0.08)
const strictResult = validateAndMaybeCorrect(moderateOverlapChair, [tableFootprint], syntheticGeometry);
check(
  "a moderate overlap (0.06m^3) with an UNDECLARED neighbor is caught (baseline, strict threshold)",
  strictResult.corrected || !strictResult.ok,
  JSON.stringify(strictResult)
);

const declaredChair: Footprint = { ...moderateOverlapChair, allowedOverlapTargetId: "table_1" };
const relaxedResult = validateAndMaybeCorrect(declaredChair, [tableFootprint], syntheticGeometry);
check(
  "the SAME overlap passes untouched once the chair declares the table as an allowed overlap target",
  relaxedResult.ok && !relaxedResult.corrected,
  JSON.stringify(relaxedResult)
);

// Reverse direction: the TABLE declares the chair as its allowed overlap
// target instead of the other way around - checkFurnitureOverlap must check
// both directions since either item could be "the item under test" depending
// on which one review_layout happens to be validating.
const chairAsOther: OtherFootprint = { key: "chair_1", localBox: boxFor(1, 1, 1), position: [0.94, floorY, 0], rotationYDegrees: 0 };
const tableDeclaring: Footprint = { ...footprintAt([0, floorY, 0], 0, 1, 1, 1), allowedOverlapTargetId: "chair_1" };
const reverseResult = validateAndMaybeCorrect(tableDeclaring, [chairAsOther], syntheticGeometry);
check(
  "the relaxation is symmetric - declaring from the OTHER side of the pair works too",
  reverseResult.ok && !reverseResult.corrected,
  JSON.stringify(reverseResult)
);

// A much bigger overlap still fails even for a declared pair - not a blanket bypass.
const hugeOverlapChair: Footprint = { ...footprintAt([0.85, floorY, 0], 0, 1, 1, 1), allowedOverlapTargetId: "table_1" }; // 0.15 m^3 > relaxed threshold (0.08)
const hugeResult = validateAndMaybeCorrect(hugeOverlapChair, [tableFootprint], syntheticGeometry);
check(
  "a much bigger overlap (0.15m^3) still fails even for a declared pair - not a blanket bypass",
  hugeResult.corrected || !hugeResult.ok,
  JSON.stringify(hugeResult)
);

// The same moderate overlap against an UNRELATED third item (not the declared
// partner) must still use the strict threshold - the relaxation is scoped to
// the exact declared pair, not "this item may overlap anything now."
const unrelatedOther: OtherFootprint = { key: "unrelated_item", localBox: boxFor(1, 1, 1), position: [0.94, floorY, 0], rotationYDegrees: 0 };
const misdirectedResult = validateAndMaybeCorrect(declaredChair, [unrelatedOther], syntheticGeometry);
check(
  "declaring an allowed overlap target does NOT relax the check against a DIFFERENT, undeclared neighbor",
  misdirectedResult.corrected || !misdirectedResult.ok,
  JSON.stringify(misdirectedResult)
);

// --- AABB inflation false-positive for wide/shallow rotated items -----------
// Reproduces the exact real bug found on a live run: a sofa placed
// in_front_of a media console (both wide/shallow, e.g. a 2.2m sofa and a
// 1.8m console) at a room-realistic tilt registered a large SPURIOUS
// furniture_overlap even though their TRUE (rotated) footprints only just
// touch - the world-axis-aligned AABB around a rotated wide/shallow rectangle
// spans much more than the rectangle itself once "wide" isn't aligned to a
// world axis, and nearestWallRotation now makes a non-zero tilt the norm, not
// the exception.
console.log("\n=== AABB inflation false-positive (wide/shallow items on a tilted axis) ===");
const TILT_DEG = 30;
const tiltRad = (TILT_DEG * Math.PI) / 180;
const forward: [number, number] = [Math.sin(tiltRad), Math.cos(tiltRad)];
const consoleLikeFootprint: OtherFootprint = { key: "console_like", localBox: boxFor(1.8, 0.4, 0.4), position: [0, floorY, 0], rotationYDegrees: TILT_DEG };
// console depth/2 + sofa depth/2 + the real 3cm default clearance
// (placementSolverService.ts's DEFAULT_CLEARANCE_M) - a LITERAL zero gap is a
// genuine geometric knife-edge for any corner-based touch test (floating-point
// boundary ambiguity), which is exactly why that small default margin exists;
// this matches what a real relative_to placement actually produces today, not
// a stricter edge case nothing in production ever hits.
const touchDistance = 0.4 / 2 + 0.9 / 2 + 0.03;
const sofaLikePosition: [number, number, number] = [forward[0] * touchDistance, floorY, forward[1] * touchDistance];
const sofaLikeFootprint = footprintAt(sofaLikePosition, TILT_DEG + 180, 2.2, 0.9, 0.9);
const tiltedTouchingResult = validateAndMaybeCorrect(sofaLikeFootprint, [consoleLikeFootprint], syntheticGeometry);
check(
  "two wide/shallow items exactly touching along a TILTED shared axis are NOT flagged as overlapping",
  tiltedTouchingResult.ok && !tiltedTouchingResult.corrected,
  JSON.stringify(tiltedTouchingResult)
);

// A genuine overlap between the same two tilted wide/shallow items (pushed
// well past merely touching) must still be caught - confirms the fix
// discriminates real collisions, it doesn't just suppress this check.
const sofaLikeOverlapping = footprintAt(
  [forward[0] * (touchDistance - 0.3), floorY, forward[1] * (touchDistance - 0.3)],
  TILT_DEG + 180,
  2.2,
  0.9,
  0.9
);
const tiltedRealOverlapResult = validateAndMaybeCorrect(sofaLikeOverlapping, [consoleLikeFootprint], syntheticGeometry);
check(
  "the same two tilted items genuinely pushed into each other are still caught as furniture_overlap",
  tiltedRealOverlapResult.corrected || !tiltedRealOverlapResult.ok,
  JSON.stringify(tiltedRealOverlapResult)
);

// --- door clearance -----------------------------------------------------------
console.log("\n=== door_clearance ===");
// Same probing strategy: try every door at a few depths into its own clear zone,
// take the first that trips door_clearance without also touching the wall.
let doorResult: ReturnType<typeof validateAndMaybeCorrect> | null = null;
for (const door of geometry.doors) {
  const wall = door.parentWallIdentifier ? geometry.walls.find((w) => w.identifier === door.parentWallIdentifier) : undefined;
  if (!wall) continue;
  const inward = wallInwardDirection(wall, geometry);
  if (!inward) continue;
  for (const depth of [0.35, 0.45, 0.55]) {
    const blockPos: [number, number, number] = [door.position[0] + inward[0] * depth, floorY, door.position[2] + inward[1] * depth];
    const blocker = footprintAt(blockPos, wall.rotationYDegrees, 1.2, 0.4, 0.6);
    const result = validateAndMaybeCorrect(blocker, [], geometry);
    if (!result.ok && result.violations.length === 1 && result.violations[0].constraint === "door_clearance") {
      doorResult = result;
      break;
    }
  }
  if (doorResult) break;
}
check("found a placement that isolates door_clearance as a violation", !!doorResult, JSON.stringify(doorResult));

// --- floor polygon -------------------------------------------------------------
console.log("\n=== floor_polygon ===");
const farOutside: [number, number, number] = [geometry.boundsMax[0] + 5, floorY, geometry.boundsMax[2] + 5];
const outsideFootprint = footprintAt(farOutside, 0, 1, 1, 1);
const outsideResult = validateAndMaybeCorrect(outsideFootprint, [], geometry);
check(
  "an item placed far outside the room's bounds fails floor_polygon",
  !outsideResult.ok && outsideResult.violations.some((v) => v.constraint === "floor_polygon"),
  JSON.stringify(outsideResult)
);

// --- ceiling height (reject only, no correction) ------------------------------
console.log("\n=== ceiling_height ===");
const tallestWall = geometry.walls.reduce((a, b) => (b.heightM > a.heightM ? b : a));
const tooTall = footprintAt([tallestWall.position[0], floorY, tallestWall.position[2]], 0, 0.5, tallestWall.heightM + 1, 0.5);
const tooTallResult = validateAndMaybeCorrect(tooTall, [], geometry);
check(
  "an item taller than the ceiling fails ceiling_height and is NOT corrected (no push fixes height)",
  !tooTallResult.ok && !tooTallResult.corrected && tooTallResult.violations.some((v) => v.constraint === "ceiling_height"),
  JSON.stringify(tooTallResult)
);

// --- validateAllPlacements: fixed-equipment items never gate on each other ----
// Confirmed as a real bug on a live E2E run: two fixed-equipment items (never
// moved by this pipeline) can have a pre-existing overlap from real scan
// noise, which used to be reported as an unfixable violation that permanently
// blocked finish_staging's gate. Fixed items must only ever be checked as a
// NEIGHBOR, never as the item under test.
console.log("\n=== validateAllPlacements: fixed-vs-fixed overlap is never reported ===");
const fixedA = { key: "fixed_a", isFixed: true, ...footprintAt([0, floorY, 0], 0, 1, 1, 1) };
const fixedB = { key: "fixed_b", isFixed: true, ...footprintAt([0.1, floorY, 0.1], 0, 1, 1, 1) };
const fixedOnlyResult = validateAllPlacements([fixedA, fixedB], geometry);
check("two overlapping fixed-equipment items report zero violations", fixedOnlyResult.length === 0, JSON.stringify(fixedOnlyResult));

console.log("\n=== validateAllPlacements: a PLACED item overlapping a fixed item is still caught ===");
const placedOverFixed = { key: "placed_item", isFixed: false, ...footprintAt([0.1, floorY, 0.1], 0, 1, 1, 1) };
const mixedResult = validateAllPlacements([fixedA, placedOverFixed], geometry);
check(
  "the placed item is flagged for overlapping the fixed item",
  mixedResult.length === 1 && mixedResult[0].key === "placed_item" && mixedResult[0].violations.some((v) => v.constraint === "furniture_overlap"),
  JSON.stringify(mixedResult)
);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
