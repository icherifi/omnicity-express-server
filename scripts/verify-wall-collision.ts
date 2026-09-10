/**
 * Standalone check for Phase 2's wall-collision detection: confirms the outward-
 * only padding means furniture pushed flush against a wall does NOT false-positive
 * (the most common staging pattern), while furniture genuinely centered inside a
 * wall's own plane DOES get flagged.
 *
 * Run: npx ts-node scripts/verify-wall-collision.ts
 */
import fs from "fs";
import path from "path";
import * as THREE from "three";
import { buildWallCollisionBoxes, wallClipVolume } from "../src/services/roomShellService";
import { LocalBoundingBox } from "../src/services/glbGeometryService";
import { RoomPlanCapturedRoom } from "../src/types/staging.types";

function entityWorldMatrix(entity: { transform: number[] }): THREE.Matrix4 {
  return new THREE.Matrix4().fromArray(entity.transform);
}

/** A sofa-shaped local box (1.6m wide x 1m tall x 0.8m deep - local Z is depth,
 * matching placedBoundingBox's convention of rotating local Z by rotationYDegrees). */
const SOFA_LOCAL_BOX: LocalBoundingBox = { min: [-0.8, -0.5, -0.4], max: [0.8, 0.5, 0.4] };

async function main() {
  const fixturePath = path.join(__dirname, "..", "src", "services", "__fixtures__", "sample-scan.json");
  const serialized = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as RoomPlanCapturedRoom;

  const overallBox = new THREE.Box3();
  for (const wall of serialized.walls) {
    const [w, h] = wall.dimensions;
    const matrix = entityWorldMatrix(wall);
    for (const c of [
      [-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [-w / 2, h / 2, 0], [w / 2, h / 2, 0],
    ] as [number, number, number][]) {
      overallBox.expandByPoint(new THREE.Vector3(...c).applyMatrix4(matrix));
    }
  }
  const room = {
    bounds_min: [overallBox.min.x, overallBox.min.y, overallBox.min.z] as [number, number, number],
    bounds_max: [overallBox.max.x, overallBox.max.y, overallBox.max.z] as [number, number, number],
    wall_object_names: [],
    floor_object_names: [],
    ceiling_object_names: [],
    floor_polygons: [],
  };

  const wallBoxes = buildWallCollisionBoxes(serialized.walls, room);
  const testWall = serialized.walls[0];
  const matrix = entityWorldMatrix(testWall);
  const wallCenter = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(wallCenter, quaternion, scale);
  const thicknessAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
  const roomCenter = new THREE.Vector3(
    (room.bounds_min[0] + room.bounds_max[0]) / 2,
    (room.bounds_min[1] + room.bounds_max[1]) / 2,
    (room.bounds_min[2] + room.bounds_max[2]) / 2
  );
  const inward = thicknessAxis.dot(roomCenter.clone().sub(wallCenter)) > 0 ? thicknessAxis : thicknessAxis.clone().negate();
  const wallYawDegrees = THREE.MathUtils.radToDeg(new THREE.Euler().setFromQuaternion(quaternion, "YXZ").y);

  // A sofa pushed back against the wall with a small realistic clearance (5cm -
  // nobody, human or LLM, computes furniture placement to sub-centimeter exact
  // wall-touching precision), rotated to match the wall's own yaw so its local
  // depth axis is parallel to the wall's thickness axis.
  const flushPos = wallCenter.clone().addScaledVector(inward, 0.45);
  const flushPosArr: [number, number, number] = [flushPos.x, flushPos.y, flushPos.z];
  const flushClips = wallBoxes.filter((w) => wallClipVolume(w, SOFA_LOCAL_BOX, flushPosArr, wallYawDegrees) > 0.01);

  // The same sofa, centered exactly on the wall's own plane - genuinely inside it.
  const wallCenterArr: [number, number, number] = [wallCenter.x, wallCenter.y, wallCenter.z];
  const insideClips = wallBoxes.filter((w) => wallClipVolume(w, SOFA_LOCAL_BOX, wallCenterArr, wallYawDegrees) > 0.01);

  const testWallBox = wallBoxes.find((w) => w.object_name === testWall.identifier)!;
  console.log("wall position:", wallCenter.toArray());
  console.log("wall yaw degrees:", wallYawDegrees);
  console.log("inward:", inward.toArray());
  console.log("flush overlap volume vs test wall:", wallClipVolume(testWallBox, SOFA_LOCAL_BOX, flushPosArr, wallYawDegrees));
  console.log(`Flush-against-wall furniture: ${flushClips.length} wall clip(s) (expect 0)`);
  console.log(`Inside-the-wall furniture: ${insideClips.length} wall clip(s) (expect >= 1)`);

  if (flushClips.length !== 0) throw new Error("FAIL: flush placement false-positived on wall collision");
  if (insideClips.length === 0) throw new Error("FAIL: furniture literally inside a wall was not detected");
  console.log("PASS");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
