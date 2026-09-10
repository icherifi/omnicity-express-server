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
