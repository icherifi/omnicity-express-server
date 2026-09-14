/**
 * Hard constraints: things a placement must satisfy, checked as a battery rather
 * than the old one-off "does it overlap another item" check. Policy is hybrid,
 * uniform across all six checks: if exactly ONE constraint is violated and it has
 * a well-defined push direction, try ONE bounded corrective nudge and re-check
 * everything; multiple simultaneous violations (or one with no clear direction,
 * like a ceiling-height failure) reject outright rather than guess. A correction
 * is always reported, never silent, so a later relative_to reference that reads
 * the item's actual resolved position stays consistent with what really happened.
 */

import { LocalBoundingBox, boxOverlapVolume, placedBoundingBox } from "./glbGeometryService";
import { OpeningDescriptor, RoomGeometry, wallClipVolume, wallInwardDirection } from "./roomShellService";
import { add, axesOf, dot, footprintCorners, length, pointInPolygon, quadsLikelyOverlap, sub, Vec2, xz } from "./geometry2d";
import { HardConstraintViolation, ValidationResult } from "../types/staging.types";

const FURNITURE_OVERLAP_VOLUME_M3 = 0.01;
/** Used ONLY between a pair that explicitly declared each other as an
 * intentional overlap partner (allowedOverlapTargetId, set exclusively via a
 * manifest slot's forced_relative_to, e.g. a dining chair tucked under its
 * own table) - every other pair still uses the strict threshold above. Sized
 * to cover that real case (≈0.06 m³, see roomManifests.ts's
 * DINING_CHAIR_TUCK_GAP_CM) while staying well below a degenerate
 * full-overlap bug (≈0.24 m³ for that same pair). */
const RELAXED_FURNITURE_OVERLAP_VOLUME_M3 = 0.08;
const WALL_OVERLAP_VOLUME_M3 = 0.01;
const DOOR_CLEAR_DEPTH_MIN_M = 0.9;
const DOOR_CLEAR_MARGIN_M = 0.1;
const WINDOW_OVERLAP_FRACTION_MAX = 0.5;
const WINDOW_HEIGHT_FRACTION_MAX = 0.6;
const WALL_PROXIMITY_MAX_M = 1.5; // beyond this, an item isn't "at" a given wall/window
const CEILING_TOLERANCE_M = 0.02;
const DEFAULT_CORRECTIVE_PUSH_M = 0.1;
const CORRECTIVE_NUDGE_MARGIN_M = 0.03;

export interface Footprint {
  /** Absent on the raw shape some callers use pre-placement (e.g.
   * resolveAndValidate's candidate, not yet a stored slot) - present whenever
   * this Footprint came from an already-placed item (see stagingToolHandlers.ts's
   * footprintOf), which is what checkFurnitureOverlap needs to test the
   * symmetric half of an allowedOverlapTargetId pair. */
  key?: string;
  localBox: LocalBoundingBox;
  position: [number, number, number];
  rotationYDegrees: number;
  widthM: number;
  depthM: number;
  heightM: number;
  /** This item is INTENTIONALLY allowed to overlap the item with this key
   * beyond the normal strict threshold (see RELAXED_FURNITURE_OVERLAP_VOLUME_M3)
   * - set only via a manifest slot's forced_relative_to, never by anything
   * Claude controls, so it can't be used to paper over an unrelated real
   * collision. */
  allowedOverlapTargetId?: string;
}

export interface OtherFootprint {
  key: string;
  localBox: LocalBoundingBox;
  position: [number, number, number];
  rotationYDegrees: number;
  allowedOverlapTargetId?: string;
}

interface ConstraintCheck {
  pass: boolean;
  violation?: HardConstraintViolation;
  /** Direction (world XZ) that would move the item OUT of this violation, if one
   * is well-defined - absent means "reject only" (e.g. ceiling height: no amount
   * of horizontal movement fixes an item that's simply too tall). */
  pushDirection?: Vec2;
  pushDistanceM?: number;
}

function checkWallPenetration(item: Footprint, geometry: RoomGeometry): ConstraintCheck {
  for (const wall of geometry.wallBoxes) {
    const volume = wallClipVolume(wall, item.localBox, item.position, item.rotationYDegrees);
    if (volume > WALL_OVERLAP_VOLUME_M3) {
      const wallDesc = geometry.walls.find((w) => w.identifier === wall.object_name);
      const inward = wallDesc ? wallInwardDirection(wallDesc, geometry) : null;
      return {
        pass: false,
        violation: { constraint: "wall_penetration", detail: `Clips through wall ${wall.object_name}.` },
        pushDirection: inward ?? undefined,
        pushDistanceM: DEFAULT_CORRECTIVE_PUSH_M,
      };
    }
  }
  return { pass: true };
}

function checkFurnitureOverlap(item: Footprint, others: OtherFootprint[]): ConstraintCheck {
  const itemBox = placedBoundingBox(item.localBox, item.position, item.rotationYDegrees);
  const itemFootprint = footprintCorners(xz(item.position), item.rotationYDegrees, item.localBox.max[0] - item.localBox.min[0], item.localBox.max[2] - item.localBox.min[2]);
  for (const other of others) {
    const otherBox = placedBoundingBox(other.localBox, other.position, other.rotationYDegrees);

    // Two cheap pre-checks rule out a real collision before ever trusting the
    // approximate world-axis-aligned AABB volume below:
    // - Y ranges that don't overlap at all can't collide regardless of XZ.
    // - The TRUE oriented XZ footprints not overlapping rules it out too - a
    //   world-aligned AABB around a rotated wide/shallow rectangle spans much
    //   more than the rectangle itself once it isn't aligned to a world axis,
    //   which nearestWallRotation makes the norm rather than the exception.
    //   Same corner-in-polygon primitive (not a full SAT) already used for
    //   resolveInCorner/checkDoorClearance - an accepted tradeoff already,
    //   not a new risk.
    if (itemBox.max[1] <= otherBox.min[1] || otherBox.max[1] <= itemBox.min[1]) continue;
    const otherFootprint = footprintCorners(xz(other.position), other.rotationYDegrees, other.localBox.max[0] - other.localBox.min[0], other.localBox.max[2] - other.localBox.min[2]);
    if (!quadsLikelyOverlap(itemFootprint, otherFootprint)) continue;

    const isDeclaredOverlapPair = item.allowedOverlapTargetId === other.key || (!!item.key && other.allowedOverlapTargetId === item.key);
    const threshold = isDeclaredOverlapPair ? RELAXED_FURNITURE_OVERLAP_VOLUME_M3 : FURNITURE_OVERLAP_VOLUME_M3;
    if (boxOverlapVolume(itemBox, otherBox) > threshold) {
      const away = sub(xz(item.position), xz(other.position));
      const dist = length(away);
      return {
        pass: false,
        violation: { constraint: "furniture_overlap", detail: `Overlaps ${other.key}.` },
        pushDirection: dist > 1e-6 ? ([away[0] / dist, away[1] / dist] as Vec2) : undefined,
        pushDistanceM: DEFAULT_CORRECTIVE_PUSH_M,
      };
    }
  }
  return { pass: true };
}

/** Cheap corner-in-either-polygon overlap test - not a full SAT, but adequate for
 * two roughly-rectangular, moderately-sized regions (a furniture footprint and a
 * door clear-zone rectangle); the rare missed edge-crossing case degrades to "no
 * violation detected" rather than a false alarm, an acceptable trade for a system
 * that already treats these checks as one signal among several. */

function doorClearZone(door: OpeningDescriptor, geometry: RoomGeometry): Vec2[] | null {
  const wall = door.parentWallIdentifier ? geometry.walls.find((w) => w.identifier === door.parentWallIdentifier) : undefined;
  if (!wall) return null;
  const inward = wallInwardDirection(wall, geometry);
  if (!inward) return null;
  const { right } = axesOf(wall.rotationYDegrees);
  const halfWidth = door.widthM / 2 + DOOR_CLEAR_MARGIN_M;
  const depth = Math.max(door.widthM, DOOR_CLEAR_DEPTH_MIN_M);
  const doorXZ = xz(door.position);
  const nearA = add(doorXZ, right, halfWidth);
  const nearB = add(doorXZ, right, -halfWidth);
  return [nearA, nearB, add(nearB, inward, depth), add(nearA, inward, depth)];
}

function checkDoorClearance(item: Footprint, geometry: RoomGeometry): ConstraintCheck {
  const itemCorners = footprintCorners(xz(item.position), item.rotationYDegrees, item.widthM, item.depthM);
  for (const door of geometry.doors) {
    const zone = doorClearZone(door, geometry);
    if (!zone || !quadsLikelyOverlap(itemCorners, zone)) continue;
    const wall = geometry.walls.find((w) => w.identifier === door.parentWallIdentifier)!;
    const inward = wallInwardDirection(wall, geometry);
    return {
      pass: false,
      violation: { constraint: "door_clearance", detail: `Blocks the clear path in front of door ${door.identifier}.` },
      // Push back toward the wall (out of the clear zone's depth), not further into the room.
      pushDirection: inward ? ([-inward[0], -inward[1]] as Vec2) : undefined,
      pushDistanceM: Math.max(door.widthM, DOOR_CLEAR_DEPTH_MIN_M),
    };
  }
  return { pass: true };
}

function checkWindowBlocked(item: Footprint, geometry: RoomGeometry): ConstraintCheck {
  for (const window of geometry.windows) {
    const wall = window.parentWallIdentifier ? geometry.walls.find((w) => w.identifier === window.parentWallIdentifier) : undefined;
    if (!wall) continue;
    const inward = wallInwardDirection(wall, geometry);
    if (!inward) continue;

    const distFromWall = dot(sub(xz(item.position), xz(wall.position)), inward);
    if (distFromWall < 0 || distFromWall > WALL_PROXIMITY_MAX_M) continue; // not plausibly "at" this wall

    const { right } = axesOf(wall.rotationYDegrees);
    const itemT = dot(sub(xz(item.position), xz(wall.position)), right);
    const windowT = dot(sub(xz(window.position), xz(wall.position)), right);
    const overlapWidth = Math.min(itemT + item.widthM / 2, windowT + window.widthM / 2) - Math.max(itemT - item.widthM / 2, windowT - window.widthM / 2);
    if (overlapWidth <= 0) continue;

    const overlapFraction = overlapWidth / window.widthM;
    const floorY = geometry.boundsMin[1];
    const sillHeightM = window.position[1] - window.heightM / 2 - floorY;
    const heightFraction = sillHeightM > 0 ? item.heightM / sillHeightM : Infinity;

    if (overlapFraction > WINDOW_OVERLAP_FRACTION_MAX && heightFraction > WINDOW_HEIGHT_FRACTION_MAX) {
      const sign = itemT >= windowT ? 1 : -1;
      return {
        pass: false,
        violation: { constraint: "window_blocked", detail: `Blocks ${(overlapFraction * 100).toFixed(0)}% of window ${window.identifier}.` },
        pushDirection: [right[0] * sign, right[1] * sign],
        pushDistanceM: overlapWidth / 2 + 0.1,
      };
    }
  }
  return { pass: true };
}

function checkFloorPolygon(item: Footprint, geometry: RoomGeometry): ConstraintCheck {
  if (!geometry.floorPolygon || geometry.floorPolygon.length < 3) return { pass: true };
  const corners = footprintCorners(xz(item.position), item.rotationYDegrees, item.widthM, item.depthM);
  const midpoints = corners.map((c, i) => {
    const n = corners[(i + 1) % corners.length];
    return [(c[0] + n[0]) / 2, (c[1] + n[1]) / 2] as Vec2;
  });
  const outside = [...corners, ...midpoints].filter((p) => !pointInPolygon(p, geometry.floorPolygon!));
  if (outside.length === 0) return { pass: true };

  const centroidDir = sub(
    geometry.floorPolygon.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0] as Vec2).map((v) => v / geometry.floorPolygon!.length) as Vec2,
    xz(item.position)
  );
  const dist = length(centroidDir);
  return {
    pass: false,
    violation: { constraint: "floor_polygon", detail: "Footprint extends outside the room's real floor outline." },
    pushDirection: dist > 1e-6 ? ([centroidDir[0] / dist, centroidDir[1] / dist] as Vec2) : undefined,
    pushDistanceM: DEFAULT_CORRECTIVE_PUSH_M,
  };
}

function checkCeilingHeight(item: Footprint, geometry: RoomGeometry): ConstraintCheck {
  let nearest = geometry.walls[0];
  let minDist = Infinity;
  for (const wall of geometry.walls) {
    const d = Math.hypot(wall.position[0] - item.position[0], wall.position[2] - item.position[2]);
    if (d < minDist) {
      minDist = d;
      nearest = wall;
    }
  }
  if (!nearest || item.heightM <= nearest.heightM + CEILING_TOLERANCE_M) return { pass: true };
  return {
    pass: false,
    violation: { constraint: "ceiling_height", detail: `Item is ${(item.heightM * 100).toFixed(0)}cm tall, taller than the ${(nearest.heightM * 100).toFixed(0)}cm ceiling here.` },
    // No push fixes a too-tall item - reject only.
  };
}

const HARD_CONSTRAINTS: Array<(item: Footprint, others: OtherFootprint[], geometry: RoomGeometry) => ConstraintCheck> = [
  (item, _others, geometry) => checkWallPenetration(item, geometry),
  (item, others) => checkFurnitureOverlap(item, others),
  (item, _others, geometry) => checkDoorClearance(item, geometry),
  (item, _others, geometry) => checkWindowBlocked(item, geometry),
  (item, _others, geometry) => checkFloorPolygon(item, geometry),
  (item, _others, geometry) => checkCeilingHeight(item, geometry),
];

function runAll(item: Footprint, others: OtherFootprint[], geometry: RoomGeometry): ConstraintCheck[] {
  return HARD_CONSTRAINTS.map((check) => check(item, others, geometry)).filter((r) => !r.pass);
}

export function validateAndMaybeCorrect(item: Footprint, others: OtherFootprint[], geometry: RoomGeometry): ValidationResult {
  const violations = runAll(item, others, geometry);
  if (violations.length === 0) {
    return { ok: true, corrected: false, position: item.position, rotation_y_degrees: item.rotationYDegrees, violations: [] };
  }

  if (violations.length === 1 && violations[0].pushDirection) {
    const push = violations[0].pushDirection;
    const dist = (violations[0].pushDistanceM ?? DEFAULT_CORRECTIVE_PUSH_M) + CORRECTIVE_NUDGE_MARGIN_M;
    const nudgedXZ = add(xz(item.position), push, dist);
    const nudged: Footprint = { ...item, position: [nudgedXZ[0], item.position[1], nudgedXZ[1]] };
    const recheck = runAll(nudged, others, geometry);
    if (recheck.length === 0) {
      return {
        ok: true,
        corrected: true,
        correction_reason: violations[0].violation!.constraint,
        position: nudged.position,
        rotation_y_degrees: nudged.rotationYDegrees,
        violations: [],
      };
    }
  }

  return {
    ok: false,
    corrected: false,
    position: item.position,
    rotation_y_degrees: item.rotationYDegrees,
    violations: violations.map((v) => v.violation!),
  };
}

/** Full-room defensive re-check (used by review_layout): every currently
 * placed item against every hard constraint, catching drift from an earlier
 * adjust_placement that moved something without cascading a re-solve to
 * items placed relative to it. `isFixed` items (never placed/moved by this
 * pipeline) are only ever checked as a NEIGHBOR, never as the item under
 * test - a pre-existing overlap between two fixed items (real scan noise)
 * can never be corrected, so reporting it would permanently block
 * finish_staging for no actionable reason. A real overlap between a fixed
 * item and something Claude placed is still caught, via the placed item's
 * own (symmetric) check. */
export function validateAllPlacements(
  items: Array<{ key: string; isFixed?: boolean } & Footprint>,
  geometry: RoomGeometry
): Array<{ key: string; violations: HardConstraintViolation[] }> {
  const results: Array<{ key: string; violations: HardConstraintViolation[] }> = [];
  for (const item of items) {
    if (item.isFixed) continue;
    const others: OtherFootprint[] = items.filter((o) => o.key !== item.key);
    const violations = runAll(item, others, geometry).map((v) => v.violation!);
    if (violations.length > 0) results.push({ key: item.key, violations });
  }
  return results;
}
