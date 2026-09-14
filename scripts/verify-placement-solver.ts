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
import { classifyZones } from "../src/services/roomZoningService";
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
const { zones } = classifyZones(geometry, inspection.sections, inspection.objects);
geometry.zones = zones;
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
let cornerWallA: string | null = null;
let cornerWallB: string | null = null;
outer: for (const a of geometry.walls) {
  for (const b of geometry.walls) {
    if (a === b) continue;
    const intent: PlacementIntent = { anchor: { kind: "in_corner", wall_id_a: a.identifier, wall_id_b: b.identifier } };
    const r = resolveIntent(intent, { widthM: 0.5, heightM: 0.9, depthM: 0.5 }, floorY, geometry, lookup);
    if (r.ok) {
      cornerResult = r;
      cornerWallA = a.identifier;
      cornerWallB = b.identifier;
      console.log(`  corner found between two walls, result:`, r);
      break outer;
    }
  }
}
check("found at least one valid corner in the fixture", cornerResult !== null && cornerResult.ok);

// --- in_corner furniture avoidance (corner_occupied) -------------------------
console.log("\n=== in_corner avoids already-placed furniture (corner_occupied) ===");
if (cornerResult && cornerResult.ok && cornerWallA && cornerWallB) {
  fakeSlots.set("corner_item", {
    key: "corner_item",
    position: cornerResult.position,
    rotationYDegrees: cornerResult.rotationYDegrees,
    widthM: 0.5,
    depthM: 0.5,
  });
  const secondCornerIntent: PlacementIntent = { anchor: { kind: "in_corner", wall_id_a: cornerWallA, wall_id_b: cornerWallB } };
  const secondCornerResult = resolveIntent(secondCornerIntent, { widthM: 0.5, heightM: 0.9, depthM: 0.5 }, floorY, geometry, lookup);
  console.log("  second item in the same corner:", secondCornerResult);
  check(
    "a second item in the same occupied corner fails with corner_occupied",
    !secondCornerResult.ok && secondCornerResult.error === "corner_occupied",
    JSON.stringify(secondCornerResult)
  );
  fakeSlots.delete("corner_item");
}

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

// --- relative_to obstacle avoidance (omitted gap_cm only) -------------------
// The actual fix for a real bug: a sofa placed in_front_of a media console
// (default gap, Claude never learns other items' exact coordinates to avoid
// them itself) landed on top of an already-placed dining chair sharing an
// increasingly crowded zone - unlike against_wall, relative_to had zero
// obstacle-avoidance of its own.
console.log("\n=== relative_to avoids already-placed furniture (omitted gap_cm only) ===");
fakeSlots.set("obstacle_1", { position: [0, floorY, 1.23], rotationYDegrees: 0, widthM: 0.6, depthM: 0.4, heightM: 0.4 });
const blockedFrontIntent: PlacementIntent = { anchor: { kind: "relative_to", target_id: "bed_1", relation: "in_front_of", align: "center" } };
const blockedFrontResult = resolveIntent(blockedFrontIntent, { widthM: 0.6, heightM: 0.4, depthM: 0.4 }, floorY, geometry, lookup);
console.log("  in_front_of bed_1 with the default spot blocked:", blockedFrontResult);
check(
  "in_front_of with an omitted gap_cm searches past an obstacle sitting at the default spot",
  blockedFrontResult.ok && blockedFrontResult.position[2] > 1.23 + 0.2,
  JSON.stringify(blockedFrontResult)
);

const explicitGapBlockedIntent: PlacementIntent = {
  anchor: { kind: "relative_to", target_id: "bed_1", relation: "in_front_of", align: "center", gap_cm: 3 },
};
const explicitGapBlockedResult = resolveIntent(explicitGapBlockedIntent, { widthM: 0.6, heightM: 0.4, depthM: 0.4 }, floorY, geometry, lookup);
check(
  "an EXPLICIT gap_cm is respected exactly even if it collides - the search only ever applies when gap_cm is omitted",
  explicitGapBlockedResult.ok && Math.abs(explicitGapBlockedResult.position[2] - 1.23) < 1e-9,
  JSON.stringify(explicitGapBlockedResult)
);
fakeSlots.delete("obstacle_1");

// --- room_center ---------------------------------------------------------------
console.log("\n=== room_center ===");
const centerIntent: PlacementIntent = { anchor: { kind: "room_center" } };
const centerResult = resolveIntent(centerIntent, { widthM: 1.2, heightM: 0.4, depthM: 0.8 }, floorY, geometry, lookup);
check("room_center resolves", centerResult.ok);
if (centerResult.ok && geometry.floorPolygon) {
  console.log("  center position:", centerResult.position);
}

// --- zone_center ---------------------------------------------------------------
console.log("\n=== zone_center ===");
check("classifyZones found at least one zone in the fixture", geometry.zones.length > 0, `got ${geometry.zones.length}`);
if (geometry.zones.length > 0) {
  const zone = geometry.zones[0];
  const zoneCenterIntent: PlacementIntent = { anchor: { kind: "zone_center", zone_id: zone.id } };
  const zoneCenterResult = resolveIntent(zoneCenterIntent, { widthM: 0.8, heightM: 0.4, depthM: 0.8 }, floorY, geometry, lookup);
  check("zone_center (no sub_region) resolves to the zone's plain centroid", zoneCenterResult.ok);
  if (zoneCenterResult.ok) {
    const dist = Math.hypot(zoneCenterResult.position[0] - zone.centroid[0], zoneCenterResult.position[2] - zone.centroid[1]);
    check("resolved position matches the zone's centroid", dist < 0.01, `dist=${dist.toFixed(3)}m`);
  }

  const halfAIntent: PlacementIntent = { anchor: { kind: "zone_center", zone_id: zone.id, sub_region: "half_a" } };
  const halfAResult = resolveIntent(halfAIntent, { widthM: 0.8, heightM: 0.4, depthM: 0.8 }, floorY, geometry, lookup);
  const halfBIntent: PlacementIntent = { anchor: { kind: "zone_center", zone_id: zone.id, sub_region: "half_b" } };
  const halfBResult = resolveIntent(halfBIntent, { widthM: 0.8, heightM: 0.4, depthM: 0.8 }, floorY, geometry, lookup);
  check("both sub_region halves resolve", halfAResult.ok && halfBResult.ok);
  if (halfAResult.ok && halfBResult.ok) {
    const sep = Math.hypot(halfAResult.position[0] - halfBResult.position[0], halfAResult.position[2] - halfBResult.position[2]);
    check("half_a and half_b resolve to different positions", sep > 0.1, `separation=${sep.toFixed(3)}m`);
  }
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

// --- nearestWallRotation (via room_center/zone_center's default rotation) ---
// Not exported directly - exercised through the two anchors that use it, by
// cross-checking against an independently-computed nearest wall (same
// nearest-by-distance rule, done here rather than importing a private
// helper). This is the fix for a real reported bug: room_center/zone_center
// used to hardcode rotationYDegrees: 0 (world space), which visibly "tilted"
// furniture whenever the room itself wasn't world-axis-aligned.
console.log("\n=== nearestWallRotation (room_center/zone_center default rotation) ===");
function nearestWallRotationForTest(pos: [number, number], geo: RoomGeometry): number {
  let closest = geo.walls[0];
  let bestDist = Infinity;
  for (const wall of geo.walls) {
    const d = Math.hypot(pos[0] - wall.position[0], pos[1] - wall.position[2]);
    if (d < bestDist) {
      bestDist = d;
      closest = wall;
    }
  }
  return closest.rotationYDegrees;
}
if (centerResult.ok) {
  const expectedRot = nearestWallRotationForTest([centerResult.position[0], centerResult.position[2]], geometry);
  check(
    "room_center's default rotation matches its nearest wall's own rotation, not hardcoded 0",
    centerResult.rotationYDegrees === expectedRot,
    `got ${centerResult.rotationYDegrees}, expected ${expectedRot}`
  );
}
if (geometry.zones.length > 0) {
  const zone = geometry.zones[0];
  const zoneNoRotIntent: PlacementIntent = { anchor: { kind: "zone_center", zone_id: zone.id } };
  const zoneNoRotResult = resolveIntent(zoneNoRotIntent, { widthM: 0.8, heightM: 0.4, depthM: 0.8 }, floorY, geometry, lookup);
  if (zoneNoRotResult.ok) {
    const expectedZoneRot = nearestWallRotationForTest([zoneNoRotResult.position[0], zoneNoRotResult.position[2]], geometry);
    check(
      "zone_center's default rotation also matches its nearest wall, not hardcoded 0",
      zoneNoRotResult.rotationYDegrees === expectedZoneRot,
      `got ${zoneNoRotResult.rotationYDegrees}, expected ${expectedZoneRot}`
    );
  }
}

// --- on_top_of (relative_to) -------------------------------------------------
// Fully geometry-independent (never touches walls/floor polygon) - safe to
// assert exact values rather than fixture-dependent bounds.
console.log("\n=== on_top_of (relative_to) ===");
const mediaConsole: ResolvedEntity = { key: "media_console_1", position: [2, floorY, 3], rotationYDegrees: 75, widthM: 1.8, depthM: 0.4, heightM: 0.4 };
fakeSlots.set("media_console_1", mediaConsole);

const tvIntent: PlacementIntent = { anchor: { kind: "relative_to", target_id: "media_console_1", relation: "on_top_of" } };
const tvResult = resolveIntent(tvIntent, { widthM: 1.2, heightM: 0.7, depthM: 0.1 }, floorY, geometry, lookup);
console.log("  tv on_top_of media_console_1 (zero gap):", tvResult);
check("on_top_of resolves", tvResult.ok);
if (tvResult.ok) {
  check(
    "XZ position matches the target's exactly - centered on top, not offset",
    Math.abs(tvResult.position[0] - mediaConsole.position[0]) < 1e-9 && Math.abs(tvResult.position[2] - mediaConsole.position[2]) < 1e-9
  );
  const expectedY = mediaConsole.position[1] + (mediaConsole.heightM ?? 0);
  check(
    "Y sits exactly on the target's top surface (position.y + heightM, no itemHeightM/2 term - this codebase's origin-at-base convention)",
    Math.abs(tvResult.position[1] - expectedY) < 1e-9,
    `expected=${expectedY}, actual=${tvResult.position[1]}`
  );
  check("rotation matches the target's own rotation (match_target default)", tvResult.rotationYDegrees === mediaConsole.rotationYDegrees);
}

const tvWithGapIntent: PlacementIntent = {
  anchor: { kind: "relative_to", target_id: "media_console_1", relation: "on_top_of", gap_cm: 5 },
};
const tvWithGapResult = resolveIntent(tvWithGapIntent, { widthM: 1.2, heightM: 0.7, depthM: 0.1 }, floorY, geometry, lookup);
if (tvResult.ok && tvWithGapResult.ok) {
  check(
    "gap_cm raises the item further above the target's top surface",
    tvWithGapResult.position[1] - tvResult.position[1] > 0.04,
    `delta=${(tvWithGapResult.position[1] - tvResult.position[1]).toFixed(4)}m`
  );
}

const onTopOfMissingIntent: PlacementIntent = { anchor: { kind: "relative_to", target_id: "does_not_exist", relation: "on_top_of" } };
const onTopOfMissingResult = resolveIntent(onTopOfMissingIntent, { widthM: 1.2, heightM: 0.7, depthM: 0.1 }, floorY, geometry, lookup);
check(
  "on_top_of against an unresolved target hard-fails with unresolved_reference, same as every other relative_to relation",
  !onTopOfMissingResult.ok && onTopOfMissingResult.error === "unresolved_reference"
);
fakeSlots.delete("media_console_1");

// --- facing_target_wall -------------------------------------------------------
console.log("\n=== facing_target_wall ===");
const facingMissingIntent: PlacementIntent = { anchor: { kind: "facing_target_wall", target_id: "does_not_exist" } };
const facingMissingResult = resolveIntent(facingMissingIntent, { widthM: 1.8, heightM: 0.4, depthM: 0.4 }, floorY, geometry, lookup);
check(
  "facing_target_wall against an unresolved target hard-fails with unresolved_reference",
  !facingMissingResult.ok && facingMissingResult.error === "unresolved_reference"
);

const sofa1 = fakeSlots.get("sofa_1");
if (cleanWall && sofa1) {
  // sofa_1 (from the against_wall test above) is backed against cleanWall,
  // facing INTO the room (away from cleanWall) - so the wall it's actually
  // facing should be a different wall, roughly opposite.
  const consoleIntent: PlacementIntent = { anchor: { kind: "facing_target_wall", target_id: "sofa_1" } };
  const consoleResult = resolveIntent(consoleIntent, { widthM: 1.8, heightM: 0.4, depthM: 0.4 }, floorY, geometry, lookup);
  console.log("  media console facing_target_wall(sofa_1):", consoleResult);
  check("facing_target_wall resolves against the real fixture", consoleResult.ok, JSON.stringify(consoleResult));
  if (consoleResult.ok) {
    const distFromSofasBackWall = Math.hypot(consoleResult.position[0] - cleanWall.position[0], consoleResult.position[2] - cleanWall.position[2]);
    check(
      "lands away from the wall sofa_1 is backed against (found the OPPOSITE wall, not the same one)",
      distFromSofasBackWall > 1.0,
      `dist=${distFromSofasBackWall.toFixed(3)}m`
    );

    // sofa_1's forward direction (the convention used throughout this file already).
    const sofaR = (sofa1.rotationYDegrees * Math.PI) / 180;
    const sofaForward: [number, number] = [Math.sin(sofaR), Math.cos(sofaR)];
    const consoleR = (consoleResult.rotationYDegrees * Math.PI) / 180;
    const consoleForward: [number, number] = [Math.sin(consoleR), Math.cos(consoleR)];
    const dotProduct = sofaForward[0] * consoleForward[0] + sofaForward[1] * consoleForward[1];
    check(
      "faces back roughly toward sofa_1 (opposite-ish direction, both being against_wall-resolved on roughly-facing walls)",
      dotProduct < 0,
      `dot=${dotProduct.toFixed(3)}, sofaRot=${sofa1.rotationYDegrees}, consoleRot=${consoleResult.rotationYDegrees}`
    );
  }
} else {
  check("facing_target_wall real-fixture test setup (needs sofa_1 from the against_wall test)", false, "cleanWall/sofa_1 unavailable - skipped");
}

// --- facing_target_wall avoids doors/windows/furniture on the found wall ---
// The actual bug behind a real observed failure: a media console placed
// facing_target_wall(sofa) kept failing on a live run because its
// sofa-centered ideal offset landed exactly on an obstacle on the far wall,
// and since Claude has no alternative parameter to vary between retries for
// this anchor kind, all 3 attempts failed identically - silently leaving
// both the console and (cascading) the TV unplaced.
console.log("\n=== facing_target_wall avoids doors/windows/furniture on the found wall (the actual TV/console bug) ===");
if (cleanWall && sofa1) {
  const PROBE_WIDTH_M = 0.5;
  const probeIntent: PlacementIntent = { anchor: { kind: "facing_target_wall", target_id: "sofa_1" } };
  const bareResult = resolveIntent(probeIntent, { widthM: PROBE_WIDTH_M, heightM: 0.4, depthM: 0.4 }, floorY, geometry, lookup);
  check("facing_target_wall resolves with nothing blocking (baseline)", bareResult.ok, JSON.stringify(bareResult));
  if (bareResult.ok) {
    // Block the exact ideal spot with a fake already-placed item - mirrors a
    // real window/door/other furniture sitting where a sofa-centered console
    // would otherwise land.
    fakeSlots.set("ideal_spot_blocker", {
      key: "ideal_spot_blocker",
      position: bareResult.position,
      rotationYDegrees: bareResult.rotationYDegrees,
      widthM: PROBE_WIDTH_M,
      depthM: 0.4,
    });
    const blockedResult = resolveIntent(probeIntent, { widthM: PROBE_WIDTH_M, heightM: 0.4, depthM: 0.4 }, floorY, geometry, lookup);
    console.log("  facing_target_wall with the ideal spot blocked:", blockedResult);
    check(
      "still resolves by falling back to the nearest free span, instead of blindly retrying the same blocked spot",
      blockedResult.ok,
      JSON.stringify(blockedResult)
    );
    if (blockedResult.ok) {
      const moved = Math.hypot(blockedResult.position[0] - bareResult.position[0], blockedResult.position[2] - bareResult.position[2]);
      check(
        "moved away from the blocked ideal spot instead of landing on top of the blocker (this used to silently overlap it every attempt)",
        moved > PROBE_WIDTH_M,
        `moved=${moved.toFixed(3)}m`
      );
    }
    fakeSlots.delete("ideal_spot_blocker");
  }
} else {
  check("facing_target_wall obstacle-avoidance test setup (needs cleanWall/sofa_1)", false, "unavailable - skipped");
}

// --- unknown wall / no free span --------------------------------------------
console.log("\n=== failure modes ===");
const unknownWallIntent: PlacementIntent = { anchor: { kind: "against_wall", wall_id: "not-a-real-wall-id" } };
const unknownWallResult = resolveIntent(unknownWallIntent, SOFA, floorY, geometry, lookup);
check("unknown wall_id fails with unknown_wall", !unknownWallResult.ok && unknownWallResult.error === "unknown_wall");

const unknownZoneIntent: PlacementIntent = { anchor: { kind: "zone_center", zone_id: "not-a-real-zone-id" } };
const unknownZoneResult = resolveIntent(unknownZoneIntent, SOFA, floorY, geometry, lookup);
check("unknown zone_id fails with unknown_zone", !unknownZoneResult.ok && unknownZoneResult.error === "unknown_zone");

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
