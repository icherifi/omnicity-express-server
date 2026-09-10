/**
 * Parses raw RoomPlan JSON (scans.serialized) into the SceneInspection shape the
 * orchestrator works with — no Blender/USD import needed, this is just reading
 * ARKit's own transform/dimensions data directly. Y-up throughout, matching
 * scans.serialized's native convention (see staging.types.ts's header comment).
 */

import * as THREE from "three";
import {
  DetectedObject,
  RoomPlanCapturedRoom,
  RoomPlanEntity,
  RoomShellInfo,
  SceneInspection,
} from "../types/staging.types";
import { LocalBoundingBox } from "./glbGeometryService";

function entityWorldMatrix(entity: RoomPlanEntity): THREE.Matrix4 {
  return new THREE.Matrix4().fromArray(entity.transform);
}

/** RoomPlan's `dimensions` is the entity's full extent, centered on its own transform's origin. */
function entityWorldBox(entity: RoomPlanEntity): THREE.Box3 {
  const [w, h, d] = entity.dimensions;
  const halfW = w / 2;
  const halfH = h / 2;
  const halfD = d / 2;
  const matrix = entityWorldMatrix(entity);
  const box = new THREE.Box3();
  const corners: [number, number, number][] = [
    [-halfW, -halfH, -halfD], [halfW, -halfH, -halfD], [-halfW, halfH, -halfD], [-halfW, -halfH, halfD],
    [halfW, halfH, -halfD], [halfW, -halfH, halfD], [-halfW, halfH, halfD], [halfW, halfH, halfD],
  ];
  for (const corner of corners) box.expandByPoint(new THREE.Vector3(...corner).applyMatrix4(matrix));
  return box;
}

/** `polygonCorners` is a list of local-frame [x, y, 0] points (the entity's own flat
 * outline, z=0 since it lies in the entity's own thickness-free plane) - map each
 * through the entity's world matrix and drop to [worldX, worldZ], the same convention
 * `entityWorldBox` already uses for its 8 box corners, just applied to an arbitrary
 * point list instead of a box's corners. */
function entityWorldPolygon(entity: RoomPlanEntity): [number, number][] {
  const corners = (entity.polygonCorners as number[][] | undefined) ?? [];
  const matrix = entityWorldMatrix(entity);
  return corners.map(([x, y, z]) => {
    const world = new THREE.Vector3(x, y, z).applyMatrix4(matrix);
    return [world.x, world.z] as [number, number];
  });
}

function entityPositionAndYaw(entity: RoomPlanEntity): { position: [number, number, number]; rotationYDegrees: number } {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  entityWorldMatrix(entity).decompose(position, quaternion, scale);
  const euler = new THREE.Euler().setFromQuaternion(quaternion, "YXZ");
  return {
    position: [position.x, position.y, position.z],
    rotationYDegrees: THREE.MathUtils.radToDeg(euler.y),
  };
}

function categoryName(entity: RoomPlanEntity): string {
  return Object.keys(entity.category)[0] ?? "unknown";
}

const WALL_COLLISION_PAD_M = 0.1;

export interface WallBox {
  object_name: string;
  /** Wall's own inverse world matrix (16 floats) - transforms a world point into
   * the wall's local frame (local X = width axis, local Y = height axis, local Z
   * = thickness axis). Collision testing happens in this local frame, NOT as a
   * precomputed world-space AABB: a wall is typically several meters wide and
   * essentially never perfectly axis-aligned in a real scan, and even a small
   * rotation angle balloons a world AABB's thickness by roughly
   * wallWidth * sin(angle) - for a 6m wall that's tens of centimeters from just a
   * few degrees of yaw, dwarfing the actual 10cm pad and causing false positives
   * on ordinary flush-against-the-wall placements. Doing the test in the wall's
   * own local frame (where the wall is trivially axis-aligned by definition)
   * avoids that entirely. */
  inverseMatrix: number[];
  halfWidth: number;
  halfHeight: number;
  padDepth: number;
  /** +1 if the wall's local +Z axis points outward (away from the room center),
   * -1 if it points inward - determines which side of local Z=0 the pad region
   * (never both, never inward) occupies. */
  outwardSign: 1 | -1;
}

function buildWallBox(wall: RoomPlanEntity, roomCenter: THREE.Vector3, padMeters: number): WallBox {
  const [w, h] = wall.dimensions;
  const matrix = entityWorldMatrix(wall);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);

  const localZ = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion); // wall's thickness axis, in world space
  const towardRoomCenter = roomCenter.clone().sub(position);
  const outwardSign: 1 | -1 = localZ.dot(towardRoomCenter) > 0 ? -1 : 1;

  return {
    object_name: wall.identifier,
    inverseMatrix: matrix.clone().invert().toArray(),
    halfWidth: w / 2,
    halfHeight: h / 2,
    padDepth: padMeters,
    outwardSign,
  };
}

/** One outward-padded collision volume per wall, `object_name` matching the same
 * raw identifier already visible to Claude via room.wall_object_names. */
export function buildWallCollisionBoxes(
  walls: RoomPlanEntity[],
  room: RoomShellInfo,
  padMeters = WALL_COLLISION_PAD_M
): WallBox[] {
  const roomCenter = new THREE.Vector3(
    (room.bounds_min[0] + room.bounds_max[0]) / 2,
    (room.bounds_min[1] + room.bounds_max[1]) / 2,
    (room.bounds_min[2] + room.bounds_max[2]) / 2
  );
  return walls.map((wall) => buildWallBox(wall, roomCenter, padMeters));
}

/**
 * Volume (m^3) of overlap between a furniture item's OWN un-rotated local box
 * (before any world AABB is taken of it) and one wall's outward-padded collision
 * region. Deliberately takes the item's raw `localBox` + `position` +
 * `rotationYDegrees` rather than an already-computed world-space `placedBox`:
 * chaining "furniture's true rotated corners -> world (via its own placement
 * matrix) -> wall-local (via the wall's inverse matrix)" as ONE combined
 * transform, then taking the local-frame AABB only once, at the very end.
 * Transforming an ALREADY-AABB'd world box into the wall's frame instead would
 * compound two rounds of AABB-of-a-rotated-box looseness (once for the world
 * AABB, again rotating that loose box into the wall's frame) - easily enough
 * extra padding on each side to swallow the whole 10cm pad and false-positive on
 * an ordinary flush-against-the-wall placement.
 */
export function wallClipVolume(
  wall: WallBox,
  localBox: LocalBoundingBox,
  position: [number, number, number],
  rotationYDegrees: number
): number {
  const quaternion = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    THREE.MathUtils.degToRad(rotationYDegrees)
  );
  const placementMatrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    quaternion,
    new THREE.Vector3(1, 1, 1)
  );
  const combined = new THREE.Matrix4().fromArray(wall.inverseMatrix).multiply(placementMatrix);

  const corners: [number, number, number][] = [
    [localBox.min[0], localBox.min[1], localBox.min[2]], [localBox.max[0], localBox.min[1], localBox.min[2]],
    [localBox.min[0], localBox.max[1], localBox.min[2]], [localBox.min[0], localBox.min[1], localBox.max[2]],
    [localBox.max[0], localBox.max[1], localBox.min[2]], [localBox.max[0], localBox.min[1], localBox.max[2]],
    [localBox.min[0], localBox.max[1], localBox.max[2]], [localBox.max[0], localBox.max[1], localBox.max[2]],
  ];
  const localFrameBox = new THREE.Box3();
  for (const c of corners) localFrameBox.expandByPoint(new THREE.Vector3(...c).applyMatrix4(combined));

  const padMin = wall.outwardSign > 0 ? 0 : -wall.padDepth;
  const padMax = wall.outwardSign > 0 ? wall.padDepth : 0;
  const wallLocalBox = new THREE.Box3(
    new THREE.Vector3(-wall.halfWidth, -wall.halfHeight, padMin),
    new THREE.Vector3(wall.halfWidth, wall.halfHeight, padMax)
  );

  const overlap = localFrameBox.clone().intersect(wallLocalBox);
  if (overlap.isEmpty()) return 0;
  const size = overlap.getSize(new THREE.Vector3());
  return size.x * size.y * size.z;
}

export function inspectRoom(serialized: RoomPlanCapturedRoom): SceneInspection {
  const shellEntities = [
    ...serialized.walls,
    ...serialized.floors,
    ...serialized.doors,
    ...serialized.windows,
    ...serialized.openings,
    ...serialized.objects,
  ];

  const overallBox = new THREE.Box3();
  for (const entity of shellEntities) overallBox.union(entityWorldBox(entity));

  const room: RoomShellInfo = {
    bounds_min: [overallBox.min.x, overallBox.min.y, overallBox.min.z],
    bounds_max: [overallBox.max.x, overallBox.max.y, overallBox.max.z],
    wall_object_names: serialized.walls.map((w) => w.identifier),
    floor_object_names: serialized.floors.map((f) => f.identifier),
    // RoomPlan's JSON has no separate ceiling array - rooms are typically open-top scans.
    ceiling_object_names: [],
    // RoomPlan gives the floor's real walkable contour directly (unlike walls, which
    // are box-only) - one polygon (a loop of [worldX, worldZ] points) per floors[]
    // entity, so a non-rectangular/L-shaped room renders and validates against its
    // actual shape instead of a bounding rectangle that overflows past the walls.
    floor_polygons: serialized.floors.map((f) => entityWorldPolygon(f)).filter((p) => p.length >= 3),
  };

  // Per-category counters, matching the old "<Category><Index>" naming (Chair0, Chair1, Storage0, ...)
  // so the rest of the system (system prompt, replace_furniture's object_name param) is unaffected.
  const categoryCounts = new Map<string, number>();
  const objects: DetectedObject[] = serialized.objects.map((entity) => {
    const category = categoryName(entity);
    const index = categoryCounts.get(category) ?? 0;
    categoryCounts.set(category, index + 1);
    const label = category.charAt(0).toUpperCase() + category.slice(1);
    const { position, rotationYDegrees } = entityPositionAndYaw(entity);
    return {
      object_name: `${label}${index}`,
      guessed_category: category,
      position,
      rotation_y_degrees: rotationYDegrees,
      dimensions_cm: entity.dimensions.map((d) => d * 100) as [number, number, number],
      roomplan_identifier: entity.identifier,
    };
  });

  return { room, objects };
}
