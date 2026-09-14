/**
 * Turns a PlacementIntent (Claude's relational description - "against this wall",
 * "faces that object") into an exact (position, rotation_y_degrees), using the
 * room's real geometry. Deliberately NOT the LLM computing coordinates itself:
 * precise alignment (flush against an angled wall, facing exactly toward another
 * object) is exactly what a raw-coordinate LLM guess is bad at and plain code is
 * good at.
 *
 * Pure 2D (XZ-plane) math throughout - every entity here is yaw-only rotation
 * (RoomPlan/this app's furniture never tilts/rolls), so plain trig is enough and
 * keeps this module decoupled from THREE.js/raw transforms entirely; callers
 * (roomShellService.ts) already did the 3D decomposition once, upstream.
 *
 * Convention, matching entityPositionAndYaw's extraction elsewhere: for yaw
 * degrees, an entity's own local +Z axis points world (sin(yaw), cos(yaw)) and its
 * local +X axis points world (cos(yaw), -sin(yaw)). "Forward" for a placed item is
 * its local +Z; "right" is its local +X.
 */

import { FacingIntent, PlacementAnchor, PlacementIntent } from "../types/staging.types";
import { floorCentroid, RoomGeometry, Zone, wallInwardDirection } from "./roomShellService";
import { add, axesOf, dirToYaw, dot, footprintCorners, neg, pointInPolygon, quadsLikelyOverlap, sub, Vec2, xz } from "./geometry2d";

const NUDGE_CLAMP_CM = 40;

export interface ResolvedEntity {
  position: [number, number, number];
  rotationYDegrees: number;
  widthM: number;
  depthM: number;
  /** Needed only for the "on_top_of" relative_to relation (stacking, e.g. a TV
   * on a media console) - every other anchor/relation stays purely 2D (XZ) and
   * ignores this. Optional so existing callers/tests that never stack don't
   * need to supply it. */
  heightM?: number;
  /** Identifying name for error messages (e.g. "corner already occupied by
   * {key}") - optional since some callers (tests) don't need it. */
  key?: string;
}

export interface EntityLookup {
  /** Resolves an already-placed/replaced furniture item (by instance_name or
   * object_name) - null if unknown or not yet placed this run. Walls/doors/
   * windows are looked up directly on RoomGeometry instead (they always exist,
   * never need "not yet placed" handling). */
  resolveFurniture(id: string): ResolvedEntity | null;
  /** Every currently-occupied slot (original scan objects included) - lets
   * against_wall avoid aiming at a spot that's clear of doors/windows but
   * already has furniture sitting there. */
  listAllPlaced(): ResolvedEntity[];
}

export type SolverErrorCode =
  | "unresolved_reference"
  | "unknown_wall"
  | "walls_not_adjacent"
  | "unreliable_wall"
  | "no_free_span"
  | "corner_occupied"
  | "unknown_zone";

export interface SolverFailure {
  ok: false;
  error: SolverErrorCode;
  message: string;
}

export interface SolverSuccess {
  ok: true;
  position: [number, number, number];
  rotationYDegrees: number;
  /** Set when a facing target wasn't resolvable yet - the item is still placed
   * (with a safe default facing), just not exactly as asked. Not an error: call
   * adjust_placement once the target exists. */
  warning?: string;
}

export type SolverResult = SolverSuccess | SolverFailure;

interface Interval {
  min: number;
  max: number;
}

function subtractIntervals(base: Interval, cuts: Interval[]): Interval[] {
  let remaining = [base];
  for (const cut of cuts) {
    const next: Interval[] = [];
    for (const r of remaining) {
      if (cut.max <= r.min || cut.min >= r.max) {
        next.push(r); // no overlap
        continue;
      }
      if (cut.min > r.min) next.push({ min: r.min, max: cut.min });
      if (cut.max < r.max) next.push({ min: cut.max, max: r.max });
    }
    remaining = next;
  }
  return remaining;
}

/** "Near enough to this wall to count as an obstruction on it" - furniture
 * further than this from the wall's plane doesn't block a NEW item from
 * sitting flush against that same wall. */
const FURNITURE_WALL_PROXIMITY_M = 1.0;

/** Every free (door/window/already-placed-furniture-free) stretch of a wall
 * that's at least itemWidthM wide, in the same t-coordinate space as
 * resolveAgainstWall's own `along` offsets (distance along the wall's `right`
 * axis from the wall's own center). Shared by resolveAgainstWall (unchanged
 * behavior - center of the biggest span when `along` is omitted) and
 * resolveFacingTargetWall (which needs to know whether ITS computed offset
 * actually lands somewhere free, not just whether the wall has room
 * somewhere). */
function computeFreeSpans(
  wall: RoomGeometry["walls"][number],
  itemWidthM: number,
  geometry: RoomGeometry,
  lookup: EntityLookup
): Interval[] {
  const { right } = axesOf(wall.rotationYDegrees);
  const inward = wallInwardDirection(wall, geometry);
  const halfWallWidth = wall.widthM / 2;
  const openings = [...geometry.doors, ...geometry.windows].filter((o) => o.parentWallIdentifier === wall.identifier);
  const openingCuts: Interval[] = openings.map((o) => {
    const t = dot(sub(xz(o.position), xz(wall.position)), right);
    return { min: t - o.widthM / 2, max: t + o.widthM / 2 };
  });

  // Also avoid already-placed furniture sitting near this wall, not just doors/windows.
  const furnitureCuts: Interval[] = inward
    ? lookup
        .listAllPlaced()
        .filter((item) => {
          const perpDist = Math.abs(dot(sub(xz(item.position), xz(wall.position)), inward));
          return perpDist <= FURNITURE_WALL_PROXIMITY_M + item.depthM / 2;
        })
        .map((item) => {
          const t = dot(sub(xz(item.position), xz(wall.position)), right);
          return { min: t - item.widthM / 2, max: t + item.widthM / 2 };
        })
    : [];

  const cuts: Interval[] = [...openingCuts, ...furnitureCuts];
  return subtractIntervals({ min: -halfWallWidth, max: halfWallWidth }, cuts).filter((span) => span.max - span.min >= itemWidthM);
}

function resolveAgainstWall(
  anchor: Extract<PlacementAnchor, { kind: "against_wall" }>,
  itemWidthM: number,
  itemDepthM: number,
  geometry: RoomGeometry,
  lookup: EntityLookup
): { position: Vec2; rotationYDegrees: number; inward: Vec2 } | SolverFailure {
  const wall = geometry.walls.find((w) => w.identifier === anchor.wall_id);
  if (!wall) return { ok: false, error: "unknown_wall", message: `No wall with id ${anchor.wall_id}` };

  const inward = wallInwardDirection(wall, geometry);
  if (!inward) {
    return {
      ok: false,
      error: "unreliable_wall",
      message: `Wall ${anchor.wall_id}'s inward direction couldn't be confirmed against the room's floor shape - try a different wall.`,
    };
  }

  const { right } = axesOf(wall.rotationYDegrees);
  const halfWallWidth = wall.widthM / 2;
  const freeSpans = computeFreeSpans(wall, itemWidthM, geometry, lookup);
  if (freeSpans.length === 0) {
    const largest = computeFreeSpans(wall, 0, geometry, lookup).reduce((best, s) => (s.max - s.min > best ? s.max - s.min : best), 0);
    return {
      ok: false,
      error: "no_free_span",
      message: `No stretch of wall ${anchor.wall_id} is free enough for a ${(itemWidthM * 100).toFixed(0)}cm-wide item (largest free span: ${(largest * 100).toFixed(0)}cm). Try another wall or a narrower item.`,
    };
  }

  let t: number;
  if (anchor.along && anchor.along !== "center") {
    const raw = anchor.along.offset_cm / 100;
    t = anchor.along.from_corner === "start" ? -halfWallWidth + raw : halfWallWidth - raw;
  } else {
    // Center of the LARGEST free span, not the wall's literal center (which might
    // be inside a doorway).
    const biggest = freeSpans.reduce((a, b) => (b.max - b.min > a.max - a.min ? b : a));
    t = (biggest.min + biggest.max) / 2;
  }

  const gapM = (anchor.gap_cm ?? 0) / 100;
  const alongWall = add(xz(wall.position), right, t);
  const position = add(alongWall, inward, itemDepthM / 2 + gapM);
  return { position, rotationYDegrees: dirToYaw(inward), inward };
}

function resolveInCorner(
  anchor: Extract<PlacementAnchor, { kind: "in_corner" }>,
  itemWidthM: number,
  itemDepthM: number,
  geometry: RoomGeometry,
  lookup: EntityLookup
): { position: Vec2; rotationYDegrees: number } | SolverFailure {
  const wallA = geometry.walls.find((w) => w.identifier === anchor.wall_id_a);
  const wallB = geometry.walls.find((w) => w.identifier === anchor.wall_id_b);
  if (!wallA) return { ok: false, error: "unknown_wall", message: `No wall with id ${anchor.wall_id_a}` };
  if (!wallB) return { ok: false, error: "unknown_wall", message: `No wall with id ${anchor.wall_id_b}` };

  const { right: rightA } = axesOf(wallA.rotationYDegrees);
  const { right: rightB } = axesOf(wallB.rotationYDegrees);
  const endpointsA: Vec2[] = [add(xz(wallA.position), rightA, wallA.widthM / 2), add(xz(wallA.position), rightA, -wallA.widthM / 2)];
  const endpointsB: Vec2[] = [add(xz(wallB.position), rightB, wallB.widthM / 2), add(xz(wallB.position), rightB, -wallB.widthM / 2)];

  const TOLERANCE_M = 0.15;
  let corner: Vec2 | null = null;
  for (const a of endpointsA) {
    for (const b of endpointsB) {
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (d <= TOLERANCE_M) {
        corner = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        break;
      }
    }
    if (corner) break;
  }
  if (!corner) {
    return {
      ok: false,
      error: "walls_not_adjacent",
      message: `Walls ${anchor.wall_id_a} and ${anchor.wall_id_b} don't share a corner within ${TOLERANCE_M * 100}cm.`,
    };
  }

  const inwardA = wallInwardDirection(wallA, geometry);
  const inwardB = wallInwardDirection(wallB, geometry);
  if (!inwardA || !inwardB) {
    return { ok: false, error: "unreliable_wall", message: `One of the corner's walls' inward direction couldn't be confirmed.` };
  }

  const gapM = (anchor.gap_cm ?? 0) / 100;
  const position = add(add(corner, inwardA, itemDepthM / 2 + gapM), inwardB, itemWidthM / 2 + gapM);
  const rotationYDegrees = dirToYaw(inwardA);

  // A corner has exactly one candidate position (no sliding free-span search
  // like against_wall) - so "avoidance" here means failing with a specific,
  // actionable error rather than silently returning a colliding position.
  const candidateCorners = footprintCorners(position, rotationYDegrees, itemWidthM, itemDepthM);
  const occupant = lookup.listAllPlaced().find((item) => {
    const itemCorners = footprintCorners(xz(item.position), item.rotationYDegrees, item.widthM, item.depthM);
    return quadsLikelyOverlap(candidateCorners, itemCorners);
  });
  if (occupant) {
    return {
      ok: false,
      error: "corner_occupied",
      message: `Corner ${anchor.wall_id_a}/${anchor.wall_id_b} is already occupied by ${occupant.key ?? "another item"} - try a different corner, or place this item before ${occupant.key ?? "that one"}.`,
    };
  }

  return { position, rotationYDegrees };
}

function resolveRelativeTo(
  anchor: Extract<PlacementAnchor, { kind: "relative_to" }>,
  itemWidthM: number,
  itemHeightM: number,
  itemDepthM: number,
  lookup: EntityLookup
): { position: Vec2; positionY?: number; rotationYDegrees: number; defaultFacing: "match_target" | "toward_target" } | SolverFailure {
  const target = lookup.resolveFurniture(anchor.target_id);
  if (!target) {
    return {
      ok: false,
      error: "unresolved_reference",
      message: `No item named '${anchor.target_id}' exists yet - place it first, then place things relative_to it.`,
    };
  }

  const { forward, right } = axesOf(target.rotationYDegrees);
  const targetXZ = xz(target.position);
  const align = anchor.align;

  if (anchor.relation === "on_top_of") {
    // Stacks on the target's own top surface, centered on it (e.g. a TV on a
    // media console). Every model here has its origin at its own base, not
    // center, so the item's positionY is simply the target's top surface -
    // no itemHeightM/2 correction needed.
    const positionY = target.position[1] + (target.heightM ?? 0) + (anchor.gap_cm ?? 0) / 100;
    return { position: targetXZ, positionY, rotationYDegrees: target.rotationYDegrees, defaultFacing: "match_target" };
  }

  // Small non-zero default clearance when gap_cm is omitted - real furniture
  // is never placed with literally zero gap. Only a minor safety margin
  // (the real overlap-accuracy fix is checkFurnitureOverlap's oriented-
  // footprint gate in layoutValidationService.ts); never applied over an
  // explicit gap_cm, including a deliberately negative one.
  const DEFAULT_CLEARANCE_M = 0.03;

  const positionForGap = (gapM: number): Vec2 => {
    if (anchor.relation === "left_of" || anchor.relation === "right_of") {
      const lateral = target.widthM / 2 + itemWidthM / 2 + gapM;
      const base = add(targetXZ, right, anchor.relation === "right_of" ? lateral : -lateral);
      const depthOffset = align === "end" ? target.depthM / 2 - itemDepthM / 2 : align === "center" ? 0 : -(target.depthM / 2 - itemDepthM / 2);
      return add(base, forward, depthOffset);
    }
    const depth = target.depthM / 2 + itemDepthM / 2 + gapM;
    const base = add(targetXZ, forward, anchor.relation === "in_front_of" ? depth : -depth);
    const lateralOffset = align === "end" ? target.widthM / 2 - itemWidthM / 2 : align === "center" ? 0 : -(target.widthM / 2 - itemWidthM / 2);
    return add(base, right, lateralOffset);
  };
  const defaultFacing: "match_target" | "toward_target" = anchor.relation === "left_of" || anchor.relation === "right_of" ? "match_target" : "toward_target";
  const rotationYDegrees = defaultFacing === "match_target" ? target.rotationYDegrees : dirToYaw(neg(forward));

  let position = positionForGap(anchor.gap_cm !== undefined ? anchor.gap_cm / 100 : DEFAULT_CLEARANCE_M);

  // relative_to has no obstacle-avoidance by construction, unlike
  // against_wall's free-span search - Claude also never learns other items'
  // exact coordinates to avoid them itself. Only search when gap_cm was
  // omitted; an explicit gap (e.g. a chair's deliberate negative tuck) is
  // always honored exactly. Search just moves further from the target, up to
  // 2m past the default, past which the hard-constraint battery should
  // report the real reason instead.
  if (anchor.gap_cm === undefined) {
    const RELATIVE_SEARCH_STEP_M = 0.1;
    const RELATIVE_SEARCH_MAX_STEPS = 20; // up to 2m past the default clearance
    for (let step = 1; step <= RELATIVE_SEARCH_MAX_STEPS; step++) {
      if (!overlapsAnyPlaced(position, rotationYDegrees, itemWidthM, itemDepthM, itemHeightM, target.position[1], lookup)) break;
      position = positionForGap(DEFAULT_CLEARANCE_M + step * RELATIVE_SEARCH_STEP_M);
    }
  }

  return { position, rotationYDegrees, defaultFacing };
}

/** True oriented-footprint + Y-interval overlap against every already-placed
 * item (mirrors layoutValidationService.ts's checkFurnitureOverlap gate, kept
 * separate rather than imported to avoid a cross-module dependency between
 * the solver and the validator - EntityLookup's ResolvedEntity already
 * carries everything needed: no localBox/GLB precision required here, just
 * "would this candidate meaningfully collide with something," used only to
 * decide whether resolveRelativeTo's search should keep looking). */
function overlapsAnyPlaced(
  position: Vec2,
  rotationYDegrees: number,
  widthM: number,
  depthM: number,
  heightM: number,
  floorY: number,
  lookup: EntityLookup
): boolean {
  const candidateCorners = footprintCorners(position, rotationYDegrees, widthM, depthM);
  const candidateYMin = floorY;
  const candidateYMax = floorY + heightM;
  return lookup.listAllPlaced().some((other) => {
    const otherYMin = other.position[1];
    const otherYMax = other.position[1] + (other.heightM ?? 0);
    if (candidateYMax <= otherYMin || otherYMax <= candidateYMin) return false;
    const otherCorners = footprintCorners(xz(other.position), other.rotationYDegrees, other.widthM, other.depthM);
    return quadsLikelyOverlap(candidateCorners, otherCorners);
  });
}

const FACING_WALL_STEP_M = 0.1;
const FACING_WALL_MAX_STEPS = 200; // 20m safety cap - covers any real room
// Slack beyond a zone's own AABB before the facing_target_wall ray-march
// considers itself "out of the zone" - absorbs the zoning grid's own 20cm
// discretization plus a bit of margin, without being loose enough to still
// cross into a genuinely different room.
const ZONE_MARGIN_M = 0.4;

/** Which zone (by AABB) a position falls inside - exact containment first,
 * falling back to the nearest centroid for a position just outside its own
 * zone's box (an irregular/diagonal real boundary can put a target's exact
 * position a few cm outside the AABB the zoning grid computed for it). Used
 * to confine resolveFacingTargetWall's ray-march to the target's own room,
 * not the whole floor polygon - see its own comment for why that matters. */
function findZoneContaining(position: Vec2, geometry: RoomGeometry): Zone | null {
  for (const z of geometry.zones) {
    if (position[0] >= z.bounds_min[0] && position[0] <= z.bounds_max[0] && position[1] >= z.bounds_min[1] && position[1] <= z.bounds_max[1]) {
      return z;
    }
  }
  if (geometry.zones.length === 0) return null;
  return geometry.zones.reduce((best, z) =>
    Math.hypot(position[0] - z.centroid[0], position[1] - z.centroid[1]) < Math.hypot(position[0] - best.centroid[0], position[1] - best.centroid[1])
      ? z
      : best
  );
}

/** Finds the wall a target is facing (steps forward from the target's own
 * position, in its own forward direction, until leaving the real floor
 * polygon - the last in-polygon point is approximately where that far wall
 * is) and positions this item against THAT wall, laterally aligned with the
 * target (so it's centered ON the target, not just "somewhere on that wall").
 * Deterministic and reusable - e.g. a TV console on the wall a sofa faces,
 * centered on the sofa, without Claude ever picking a wall_id itself. Delegates
 * the actual placement to resolveAgainstWall via a synthetic explicit-offset
 * anchor, reusing its furniture-avoidance/free-span logic rather than
 * duplicating it. */
function resolveFacingTargetWall(
  anchor: Extract<PlacementAnchor, { kind: "facing_target_wall" }>,
  itemWidthM: number,
  itemDepthM: number,
  geometry: RoomGeometry,
  lookup: EntityLookup
): { position: Vec2; rotationYDegrees: number; inward: Vec2 } | SolverFailure {
  const target = lookup.resolveFurniture(anchor.target_id);
  if (!target) {
    return {
      ok: false,
      error: "unresolved_reference",
      message: `No item named '${anchor.target_id}' exists yet - place it first, then place things facing it.`,
    };
  }
  if (!geometry.floorPolygon || geometry.floorPolygon.length < 3) {
    return { ok: false, error: "unreliable_wall", message: `No real floor polygon available to find the wall '${anchor.target_id}' faces.` };
  }

  const { forward } = axesOf(target.rotationYDegrees);
  const targetXZ = xz(target.position);
  // Confine the search to the target's own zone, not the whole floor polygon
  // - in an open-plan apartment, stepping forward from a target can cross
  // through a doorway into an entirely different room before the floor
  // polygon itself ends, landing on a wall with no relation to the target's
  // own room.
  const targetZone = findZoneContaining(targetXZ, geometry);
  let boundaryPoint = targetXZ;
  for (let i = 1; i <= FACING_WALL_MAX_STEPS; i++) {
    const candidate = add(targetXZ, forward, i * FACING_WALL_STEP_M);
    if (!pointInPolygon(candidate, geometry.floorPolygon)) break;
    if (
      targetZone &&
      (candidate[0] < targetZone.bounds_min[0] - ZONE_MARGIN_M ||
        candidate[0] > targetZone.bounds_max[0] + ZONE_MARGIN_M ||
        candidate[1] < targetZone.bounds_min[1] - ZONE_MARGIN_M ||
        candidate[1] > targetZone.bounds_max[1] + ZONE_MARGIN_M)
    ) {
      break;
    }
    boundaryPoint = candidate;
  }

  if (geometry.walls.length === 0) {
    return { ok: false, error: "unreliable_wall", message: `No walls in this room's geometry.` };
  }
  let nearestWall = geometry.walls[0];
  let bestDist = Infinity;
  for (const wall of geometry.walls) {
    const d = Math.hypot(boundaryPoint[0] - wall.position[0], boundaryPoint[1] - wall.position[2]);
    if (d < bestDist) {
      bestDist = d;
      nearestWall = wall;
    }
  }

  // Ideal lateral offset along the found wall: centered on the target's own
  // lateral (right-axis) position, clamped so the item's full body stays
  // within the wall's own span (the target's alignment could otherwise
  // project past a shorter far wall's edge).
  const { right: wallRight } = axesOf(nearestWall.rotationYDegrees);
  const centeredT = dot(sub(targetXZ, xz(nearestWall.position)), wallRight);
  const halfWallWidth = nearestWall.widthM / 2;
  const idealT = Math.max(-halfWallWidth + itemWidthM / 2, Math.min(halfWallWidth - itemWidthM / 2, centeredT));

  // The ideal (target-aligned) offset is only usable if it's actually free of
  // doors/windows/furniture on the found wall - unlike Claude's own explicit
  // against_wall+along calls (meant to fail loudly so Claude can retry
  // elsewhere), this anchor gives Claude no alternative to vary between
  // attempts, so falling back to the closest free span instead of failing
  // outright is what makes it usable at all.
  const freeSpans = computeFreeSpans(nearestWall, itemWidthM, geometry, lookup);
  if (freeSpans.length === 0) {
    return {
      ok: false,
      error: "no_free_span",
      message: `No stretch of the wall '${anchor.target_id}' faces is free enough for a ${(itemWidthM * 100).toFixed(0)}cm-wide item.`,
    };
  }
  const idealFits = freeSpans.some((span) => idealT - itemWidthM / 2 >= span.min && idealT + itemWidthM / 2 <= span.max);
  const closestSpan = freeSpans.reduce((best, span) =>
    Math.abs((span.min + span.max) / 2 - idealT) < Math.abs((best.min + best.max) / 2 - idealT) ? span : best
  );
  const finalT = idealFits ? idealT : (closestSpan.min + closestSpan.max) / 2;
  const offsetFromStartM = finalT + halfWallWidth;

  const syntheticAnchor: Extract<PlacementAnchor, { kind: "against_wall" }> = {
    kind: "against_wall",
    wall_id: nearestWall.identifier,
    along: { from_corner: "start", offset_cm: offsetFromStartM * 100 },
    gap_cm: anchor.gap_cm,
  };
  return resolveAgainstWall(syntheticAnchor, itemWidthM, itemDepthM, geometry, lookup);
}

/** Default rotation for an item placed at a room/zone center: parallel to the
 * nearest wall, not a hardcoded world-0deg (which has no relationship to a
 * wall's actual angle in a non-axis-aligned room). Same rotation convention
 * against_wall already uses. */
function nearestWallRotation(position: Vec2, geometry: RoomGeometry): number {
  if (geometry.walls.length === 0) return 0;
  let closest = geometry.walls[0];
  let bestDist = Infinity;
  for (const wall of geometry.walls) {
    const d = Math.hypot(position[0] - wall.position[0], position[1] - wall.position[2]);
    if (d < bestDist) {
      bestDist = d;
      closest = wall;
    }
  }
  return closest.rotationYDegrees;
}

function resolveRoomCenter(geometry: RoomGeometry): Vec2 {
  return floorCentroid(geometry);
}

/** Mirrors resolveRoomCenter but keyed to one zone instead of the whole floor -
 * lets a manifest slot target "centered in this zone" (e.g. a dining table in
 * the dining half of a combined living+dining zone) without Claude ever
 * choosing a raw coordinate. sub_region splits the zone along its own longer
 * bounding-box axis: half_a is the half closer to the whole floor's centroid,
 * half_b the farther half - a deterministic rule rather than an ambiguous
 * "left"/"right" relative to an unstated viewpoint. */
function resolveZoneCenter(
  anchor: Extract<PlacementAnchor, { kind: "zone_center" }>,
  geometry: RoomGeometry
): { position: Vec2; rotationYDegrees: number } | SolverFailure {
  const zone = geometry.zones.find((z) => z.id === anchor.zone_id);
  if (!zone) return { ok: false, error: "unknown_zone", message: `No zone with id ${anchor.zone_id}` };
  if (!anchor.sub_region) return { position: zone.centroid, rotationYDegrees: nearestWallRotation(zone.centroid, geometry) };

  const spanX = zone.bounds_max[0] - zone.bounds_min[0];
  const spanZ = zone.bounds_max[1] - zone.bounds_min[1];
  const longerAxis: Vec2 = spanX >= spanZ ? [1, 0] : [0, 1];
  const halfExtent = (spanX >= spanZ ? spanX : spanZ) / 4; // quarter-span from center = center of one half

  const candidateA = add(zone.centroid, longerAxis, halfExtent);
  const candidateB = add(zone.centroid, longerAxis, -halfExtent);
  const floorCenter = floorCentroid(geometry);
  const distA = Math.hypot(candidateA[0] - floorCenter[0], candidateA[1] - floorCenter[1]);
  const distB = Math.hypot(candidateB[0] - floorCenter[0], candidateB[1] - floorCenter[1]);
  const [nearer, farther] = distA <= distB ? [candidateA, candidateB] : [candidateB, candidateA];
  const finalPosition = anchor.sub_region === "half_a" ? nearer : farther;

  return { position: finalPosition, rotationYDegrees: nearestWallRotation(finalPosition, geometry) };
}

function resolveFacing(
  facing: FacingIntent | undefined,
  defaultYaw: number,
  position: Vec2,
  geometry: RoomGeometry,
  lookup: EntityLookup
): { rotationYDegrees: number; warning?: string } {
  if (!facing) return { rotationYDegrees: defaultYaw };

  switch (facing.kind) {
    case "away_from_wall":
    case "match_target":
    case "toward_target":
      // Already baked into defaultYaw by the anchor resolver (these are also the
      // anchor's own defaults) - an explicit request for the same behavior is a
      // no-op, not an error, even if the anchor wasn't wall/relative_to-based.
      return { rotationYDegrees: defaultYaw };

    case "toward_room_center": {
      const dir = sub(resolveRoomCenter(geometry), position);
      return { rotationYDegrees: dirToYaw(dir) };
    }

    case "toward_object": {
      const target = lookup.resolveFurniture(facing.target_id);
      if (!target) {
        return {
          rotationYDegrees: defaultYaw,
          warning: `facing target '${facing.target_id}' not placed yet - defaulted rotation. Call adjust_placement once it exists.`,
        };
      }
      return { rotationYDegrees: dirToYaw(sub(xz(target.position), position)) };
    }

    case "toward_wall": {
      const wall = geometry.walls.find((w) => w.identifier === facing.wall_id);
      if (!wall) return { rotationYDegrees: defaultYaw, warning: `Unknown wall_id '${facing.wall_id}' in facing - defaulted rotation.` };
      return { rotationYDegrees: dirToYaw(sub(xz(wall.position), position)) };
    }

    case "toward_window": {
      const window = geometry.windows.find((w) => w.identifier === facing.window_id);
      if (!window) return { rotationYDegrees: defaultYaw, warning: `Unknown window_id '${facing.window_id}' in facing - defaulted rotation.` };
      return { rotationYDegrees: dirToYaw(sub(xz(window.position), position)) };
    }

    case "explicit_degrees":
      return { rotationYDegrees: facing.degrees };

    default:
      return { rotationYDegrees: defaultYaw };
  }
}

export function resolveIntent(
  intent: PlacementIntent,
  itemDimensionsM: { widthM: number; heightM: number; depthM: number },
  floorY: number,
  geometry: RoomGeometry,
  lookup: EntityLookup
): SolverResult {
  const { widthM, heightM, depthM } = itemDimensionsM;
  let anchorResult: { position: Vec2; rotationYDegrees: number; positionY?: number } | SolverFailure;

  switch (intent.anchor.kind) {
    case "against_wall":
      anchorResult = resolveAgainstWall(intent.anchor, widthM, depthM, geometry, lookup);
      break;
    case "in_corner":
      anchorResult = resolveInCorner(intent.anchor, widthM, depthM, geometry, lookup);
      break;
    case "relative_to":
      anchorResult = resolveRelativeTo(intent.anchor, widthM, heightM, depthM, lookup);
      break;
    case "room_center": {
      const centerPos = resolveRoomCenter(geometry);
      anchorResult = { position: centerPos, rotationYDegrees: nearestWallRotation(centerPos, geometry) };
      break;
    }
    case "zone_center":
      anchorResult = resolveZoneCenter(intent.anchor, geometry);
      break;
    case "facing_target_wall":
      anchorResult = resolveFacingTargetWall(intent.anchor, widthM, depthM, geometry, lookup);
      break;
  }

  if ("ok" in anchorResult && anchorResult.ok === false) return anchorResult;
  const resolved = anchorResult as { position: Vec2; rotationYDegrees: number; positionY?: number };

  const { rotationYDegrees, warning } = resolveFacing(
    intent.facing,
    resolved.rotationYDegrees,
    resolved.position,
    geometry,
    lookup
  );

  let finalPos = resolved.position;
  if (intent.nudge_cm) {
    const forwardCm = Math.max(-NUDGE_CLAMP_CM, Math.min(NUDGE_CLAMP_CM, intent.nudge_cm.forward ?? 0));
    const lateralCm = Math.max(-NUDGE_CLAMP_CM, Math.min(NUDGE_CLAMP_CM, intent.nudge_cm.lateral ?? 0));
    const { forward, right } = axesOf(rotationYDegrees);
    finalPos = add(add(finalPos, forward, forwardCm / 100), right, lateralCm / 100);
  }

  return {
    ok: true,
    // positionY (set only by relative_to's on_top_of, for stacking) overrides
    // the room's floor height - every other anchor sits on the floor.
    position: [finalPos[0], resolved.positionY ?? floorY, finalPos[1]],
    rotationYDegrees,
    warning,
  };
}
