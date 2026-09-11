/**
 * Standalone check for Phase 3's placement solver against the real fixture -
 * every anchor type, facing resolution, nudge clamping, and the documented
 * failure modes (unresolved reference, unknown wall, no free span).
 *
 * Run: npx ts-node scripts/verify-placement-solver.ts
 */
import fs from "fs";
import path from "path";
import { inspectRoom, buildRoomGeometry, RoomGeometry } from "../src/services/roomShellService";
import { resolveIntent, EntityLookup, ResolvedEntity } from "../src/services/placementSolverService";
import { PlacementIntent, RoomPlanCapturedRoom } from "../src/types/staging.types";

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  PASS: ${label}`);
  } else {
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
const lookup: EntityLookup = {
  resolveFurniture: (id) => fakeSlots.get(id) ?? null,
  listAllPlaced: () => [...fakeSlots.values()],
};

const SOFA = { widthM: 1.6, heightM: 1.0, depthM: 0.8 };

// --- against_wall -----------------------------------------------------------
console.log("\n=== against_wall ===");
// Pick a wall with no doors/windows on it, for a clean test.
const openings = [...geometry.doors, ...geometry.windows];
const cleanWall = geometry.walls.find((w) => !openings.some((o) => o.parentWallIdentifier === w.identifier) && w.widthM > SOFA.widthM + 0.2);
check("found a clean, wide-enough wall to test against", !!cleanWall);
if (cleanWall) {
  const intent: PlacementIntent = { anchor: { kind: "against_wall", wall_id: cleanWall.identifier } };
  const result = resolveIntent(intent, SOFA, floorY, geometry, lookup);
  console.log("  result:", result);
  check("solve succeeded", result.ok);
  if (result.ok) {
    const dx = result.position[0] - cleanWall.position[0];
    const dz = result.position[2] - cleanWall.position[2];
    const distFromWallCenter = Math.hypot(dx, dz);
    check(
      `item sits roughly depth/2 (${SOFA.depthM / 2}m) from the wall's centerline`,
      distFromWallCenter > 0.3 && distFromWallCenter < 0.6,
      `actual dist=${distFromWallCenter.toFixed(3)}`
    );
    // Stepping further along the item's own forward direction should move it
    // AWAY from the wall (deeper into the room), confirming "away_from_wall".
    const r = (result.rotationYDegrees * Math.PI) / 180;
    const forward: [number, number] = [Math.sin(r), Math.cos(r)];
    const stepped: [number, number] = [result.position[0] + forward[0], result.position[2] + forward[1]];
    const distBefore = Math.hypot(result.position[0] - cleanWall.position[0], result.position[2] - cleanWall.position[2]);
    const distAfter = Math.hypot(stepped[0] - cleanWall.position[0], stepped[1] - cleanWall.position[2]);
    check("facing points away from the wall (stepping forward increases distance)", distAfter > distBefore);

    fakeSlots.set("sofa_1", { position: result.position, rotationYDegrees: result.rotationYDegrees, widthM: SOFA.widthM, depthM: SOFA.depthM });

    // --- furniture-aware free-span (the actual fix) ---------------------------
    console.log("\n=== against_wall avoids already-placed furniture ===");
    const secondIntent: PlacementIntent = { anchor: { kind: "against_wall", wall_id: cleanWall.identifier } };
    const secondResult = resolveIntent(secondIntent, { widthM: 0.6, heightM: 0.9, depthM: 0.5 }, floorY, geometry, lookup);
    console.log("  second item (default centering, same wall):", secondResult);
    check("a second default-centered item on the same occupied wall still resolves", secondResult.ok);
    if (secondResult.ok) {
      const dx2 = secondResult.position[0] - result.position[0];
      const dz2 = secondResult.position[2] - result.position[2];
      const sep = Math.hypot(dx2, dz2);
      const minSeparation = SOFA.widthM / 2 + 0.6 / 2; // half-widths shouldn't overlap
      check(
        "it lands clear of the first item instead of on top of it (the actual bug this fixes)",
        sep >= minSeparation - 0.05,
        `separation=${sep.toFixed(3)}m, need>=${minSeparation.toFixed(3)}m`
      );
    }
  }
}

// --- in_corner ---------------------------------------------------------------
console.log("\n=== in_corner ===");
let cornerResult: ReturnType<typeof resolveIntent> | null = null;
outer: for (const a of geometry.walls) {
  for (const b of geometry.walls) {
    if (a === b) continue;
    const intent: PlacementIntent = { anchor: { kind: "in_corner", wall_id_a: a.identifier, wall_id_b: b.identifier } };
    const r = resolveIntent(intent, { widthM: 0.5, heightM: 0.9, depthM: 0.5 }, floorY, geometry, lookup);
    if (r.ok) {
      cornerResult = r;
      console.log(`  corner found between two walls, result:`, r);
      break outer;
    }
  }
}
check("found at least one valid corner in the fixture", cornerResult !== null && cornerResult.ok);

// --- relative_to --------------------------------------------------------------
console.log("\n=== relative_to ===");
const bedPos: [number, number, number] = [0, floorY, 0];
fakeSlots.set("bed_1", { position: bedPos, rotationYDegrees: 0, widthM: 1.6, depthM: 2.0 });

const leftIntent: PlacementIntent = { anchor: { kind: "relative_to", target_id: "bed_1", relation: "left_of" } };
const leftResult = resolveIntent(leftIntent, { widthM: 0.4, heightM: 0.5, depthM: 0.4 }, floorY, geometry, lookup);
console.log("  left_of bed_1:", leftResult);
check("left_of resolves", leftResult.ok);
if (leftResult.ok) check("left_of sits on -X side of bed (bed faces +Z, right=+X)", leftResult.position[0] < bedPos[0]);

const rightIntent: PlacementIntent = { anchor: { kind: "relative_to", target_id: "bed_1", relation: "right_of" } };
const rightResult = resolveIntent(rightIntent, { widthM: 0.4, heightM: 0.5, depthM: 0.4 }, floorY, geometry, lookup);
check("right_of resolves on +X side", rightResult.ok && rightResult.position[0] > bedPos[0]);

const frontIntent: PlacementIntent = { anchor: { kind: "relative_to", target_id: "bed_1", relation: "in_front_of" } };
const frontResult = resolveIntent(frontIntent, { widthM: 0.6, heightM: 0.4, depthM: 0.4 }, floorY, geometry, lookup);
check("in_front_of resolves on +Z side (bed's forward)", frontResult.ok && frontResult.position[2] > bedPos[2]);

const missingIntent: PlacementIntent = { anchor: { kind: "relative_to", target_id: "does_not_exist", relation: "left_of" } };
const missingResult = resolveIntent(missingIntent, SOFA, floorY, geometry, lookup);
check("unresolved relative_to target hard-fails with unresolved_reference", !missingResult.ok && missingResult.error === "unresolved_reference");

// --- room_center ---------------------------------------------------------------
console.log("\n=== room_center ===");
const centerIntent: PlacementIntent = { anchor: { kind: "room_center" } };
const centerResult = resolveIntent(centerIntent, { widthM: 1.2, heightM: 0.4, depthM: 0.8 }, floorY, geometry, lookup);
check("room_center resolves", centerResult.ok);
if (centerResult.ok && geometry.floorPolygon) {
  console.log("  center position:", centerResult.position);
}

// --- facing variants -------------------------------------------------------
console.log("\n=== facing ===");
const towardObjIntent: PlacementIntent = {
  anchor: { kind: "room_center" },
  facing: { kind: "toward_object", target_id: "bed_1" },
};
const towardObjResult = resolveIntent(towardObjIntent, { widthM: 0.5, heightM: 0.9, depthM: 0.5 }, floorY, geometry, lookup);
check("toward_object (existing target) resolves without warning", towardObjResult.ok && !towardObjResult.warning);

const towardMissingIntent: PlacementIntent = {
  anchor: { kind: "room_center" },
  facing: { kind: "toward_object", target_id: "nonexistent_item" },
};
const towardMissingResult = resolveIntent(towardMissingIntent, { widthM: 0.5, heightM: 0.9, depthM: 0.5 }, floorY, geometry, lookup);
check(
  "toward_object (missing target) soft-falls-back with a warning, still succeeds",
  towardMissingResult.ok && !!towardMissingResult.warning
);

const explicitIntent: PlacementIntent = { anchor: { kind: "room_center" }, facing: { kind: "explicit_degrees", degrees: 42 } };
const explicitResult = resolveIntent(explicitIntent, { widthM: 0.5, heightM: 0.9, depthM: 0.5 }, floorY, geometry, lookup);
check("explicit_degrees is honored exactly", explicitResult.ok && explicitResult.rotationYDegrees === 42);

// --- nudge -----------------------------------------------------------------
console.log("\n=== nudge_cm ===");
const nudgeIntent: PlacementIntent = { anchor: { kind: "room_center" }, nudge_cm: { forward: 1000, lateral: -1000 } };
const nudgeResult = resolveIntent(nudgeIntent, { widthM: 0.5, heightM: 0.9, depthM: 0.5 }, floorY, geometry, lookup);
if (nudgeResult.ok && centerResult.ok) {
  const dist = Math.hypot(nudgeResult.position[0] - centerResult.position[0], nudgeResult.position[2] - centerResult.position[2]);
  // Clamped to +-40cm each axis -> max displacement = hypot(0.4,0.4) =~ 0.566m
  check("nudge is clamped to +-40cm per axis even when asked for 1000cm", dist < 0.6, `actual=${dist.toFixed(3)}m`);
}

// --- unknown wall / no free span --------------------------------------------
console.log("\n=== failure modes ===");
const unknownWallIntent: PlacementIntent = { anchor: { kind: "against_wall", wall_id: "not-a-real-wall-id" } };
const unknownWallResult = resolveIntent(unknownWallIntent, SOFA, floorY, geometry, lookup);
check("unknown wall_id fails with unknown_wall", !unknownWallResult.ok && unknownWallResult.error === "unknown_wall");

// Pick a wall confirmed reliable (resolves fine for a tiny item) first, then
// re-request on that SAME wall with an item wider than it - isolates
// no_free_span from the separate unreliable_wall failure mode.
const reliableNarrowWall = geometry.walls
  .filter((w) => resolveIntent({ anchor: { kind: "against_wall", wall_id: w.identifier } }, { widthM: 0.1, heightM: 0.1, depthM: 0.1 }, floorY, geometry, lookup).ok)
  .reduce((a, b) => (b.widthM < a.widthM ? b : a));
const tooWideIntent: PlacementIntent = { anchor: { kind: "against_wall", wall_id: reliableNarrowWall.identifier } };
const tooWideResult = resolveIntent(tooWideIntent, { widthM: reliableNarrowWall.widthM + 5, heightM: 1, depthM: 0.5 }, floorY, geometry, lookup);
check(
  "an item wider than the wall fails with no_free_span",
  !tooWideResult.ok && tooWideResult.error === "no_free_span",
  JSON.stringify(tooWideResult)
);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
