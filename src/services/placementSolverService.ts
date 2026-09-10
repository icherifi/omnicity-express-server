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
import { floorCentroid, RoomGeometry, wallInwardDirection } from "./roomShellService";
import { add, axesOf, dirToYaw, dot, neg, sub, Vec2, xz } from "./geometry2d";

const NUDGE_CLAMP_CM = 40;

export interface ResolvedEntity {
  position: [number, number, number];
  rotationYDegrees: number;
  widthM: number;
  depthM: number;
}

export interface EntityLookup {
  /** Resolves an already-placed/replaced furniture item (by instance_name or
   * object_name) - null if unknown or not yet placed this run. Walls/doors/
   * windows are looked up directly on RoomGeometry instead (they always exist,
   * never need "not yet placed" handling). */
  resolveFurniture(id: string): ResolvedEntity | null;
}

export type SolverErrorCode =
  | "unresolved_reference"
  | "unknown_wall"
  | "walls_not_adjacent"
  | "unreliable_wall"
  | "no_free_span";

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

function resolveAgainstWall(
  anchor: Extract<PlacementAnchor, { kind: "against_wall" }>,
  itemWidthM: number,
  itemDepthM: number,
  geometry: RoomGeometry
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
  const openings = [...geometry.doors, ...geometry.windows].filter((o) => o.parentWallIdentifier === wall.identifier);
  const cuts: Interval[] = openings.map((o) => {
    const t = dot(sub(xz(o.position), xz(wall.position)), right);
    return { min: t - o.widthM / 2, max: t + o.widthM / 2 };
  });

  const freeSpans = subtractIntervals({ min: -halfWallWidth, max: halfWallWidth }, cuts).filter(
    (span) => span.max - span.min >= itemWidthM
  );
  if (freeSpans.length === 0) {
    const largest = subtractIntervals({ min: -halfWallWidth, max: halfWallWidth }, cuts).reduce(
      (best, s) => (s.max - s.min > best ? s.max - s.min : best),
      0
    );
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
  geometry: RoomGeometry
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
  return { position, rotationYDegrees: dirToYaw(inwardA) };
}

function resolveRelativeTo(
  anchor: Extract<PlacementAnchor, { kind: "relative_to" }>,
  itemWidthM: number,
  itemDepthM: number,
  lookup: EntityLookup
): { position: Vec2; rotationYDegrees: number; defaultFacing: "match_target" | "toward_target" } | SolverFailure {
  const target = lookup.resolveFurniture(anchor.target_id);
  if (!target) {
    return {
      ok: false,
      error: "unresolved_reference",
      message: `No item named '${anchor.target_id}' exists yet - place it first, then place things relative_to it.`,
    };
  }

  const { forward, right } = axesOf(target.rotationYDegrees);
  const gapM = (anchor.gap_cm ?? 0) / 100;
  const targetXZ = xz(target.position);
  const align = anchor.align;

  let position: Vec2;
  let defaultFacing: "match_target" | "toward_target";
  if (anchor.relation === "left_of" || anchor.relation === "right_of") {
    const lateral = target.widthM / 2 + itemWidthM / 2 + gapM;
    const base = add(targetXZ, right, anchor.relation === "right_of" ? lateral : -lateral);
    const depthOffset = align === "end" ? target.depthM / 2 - itemDepthM / 2 : align === "center" ? 0 : -(target.depthM / 2 - itemDepthM / 2);
    position = add(base, forward, depthOffset);
    defaultFacing = "match_target";
  } else {
    const depth = target.depthM / 2 + itemDepthM / 2 + gapM;
    const base = add(targetXZ, forward, anchor.relation === "in_front_of" ? depth : -depth);
    const lateralOffset = align === "end" ? target.widthM / 2 - itemWidthM / 2 : align === "center" ? 0 : -(target.widthM / 2 - itemWidthM / 2);
    position = add(base, right, lateralOffset);
    defaultFacing = "toward_target";
  }

  return { position, rotationYDegrees: defaultFacing === "match_target" ? target.rotationYDegrees : dirToYaw(neg(forward)), defaultFacing };
}

function resolveRoomCenter(geometry: RoomGeometry): Vec2 {
  return floorCentroid(geometry);
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
  const { widthM, depthM } = itemDimensionsM;
  let anchorResult: { position: Vec2; rotationYDegrees: number } | SolverFailure;

  switch (intent.anchor.kind) {
    case "against_wall":
      anchorResult = resolveAgainstWall(intent.anchor, widthM, depthM, geometry);
      break;
    case "in_corner":
      anchorResult = resolveInCorner(intent.anchor, widthM, depthM, geometry);
      break;
    case "relative_to":
      anchorResult = resolveRelativeTo(intent.anchor, widthM, depthM, lookup);
      break;
    case "room_center":
      anchorResult = { position: resolveRoomCenter(geometry), rotationYDegrees: 0 };
      break;
  }

  if ("ok" in anchorResult && anchorResult.ok === false) return anchorResult;
  const resolved = anchorResult as { position: Vec2; rotationYDegrees: number };

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
    position: [finalPos[0], floorY, finalPos[1]],
    rotationYDegrees,
    warning,
  };
}
