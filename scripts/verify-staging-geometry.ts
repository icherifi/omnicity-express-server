/**
 * Standalone check for Phase 1 of the Blender->Three.js staging migration.
 * Not wired into Express - run directly: npx ts-node scripts/verify-staging-geometry.ts
 *
 * Verifies, with zero Claude API cost:
 *  1. roomShellService correctly parses a real scans.serialized fixture into
 *     room bounds + a per-category-named object list.
 *  2. ikeaService can search, check existence, and download a real GLB.
 *  3. glbGeometryService measures plausible real-world dimensions from that GLB
 *     without needing a full 3D engine.
 */

import fs from "fs";
import path from "path";
import { inspectRoom } from "../src/services/roomShellService";
import * as ikeaService from "../src/services/ikeaService";
import { computeLocalBoundingBox, dimensionsCm } from "../src/services/glbGeometryService";
import { RoomPlanCapturedRoom } from "../src/types/staging.types";

async function main() {
  console.log("=== 1. roomShellService ===");
  const fixturePath = path.join(__dirname, "..", "src", "services", "__fixtures__", "sample-scan.json");
  const serialized = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as RoomPlanCapturedRoom;

  const inspection = inspectRoom(serialized);
  console.log("room bounds_min:", inspection.room.bounds_min.map((n) => n.toFixed(2)));
  console.log("room bounds_max:", inspection.room.bounds_max.map((n) => n.toFixed(2)));
  console.log("wall count:", inspection.room.wall_object_names.length);
  console.log("floor count:", inspection.room.floor_object_names.length);
  console.log("object count:", inspection.objects.length);
  console.log(
    "sample objects:",
    inspection.objects.slice(0, 5).map((o) => ({
      name: o.object_name,
      category: o.guessed_category,
      position: o.position.map((n) => n.toFixed(2)),
      rotation_y: o.rotation_y_degrees.toFixed(1),
      dims_cm: o.dimensions_cm.map((n) => n.toFixed(0)),
    }))
  );

  const roomSpanX = inspection.room.bounds_max[0] - inspection.room.bounds_min[0];
  const roomSpanZ = inspection.room.bounds_max[2] - inspection.room.bounds_min[2];
  console.log(`room footprint: ${roomSpanX.toFixed(2)}m x ${roomSpanZ.toFixed(2)}m (sanity: should be a plausible room, not 0 or 1000s)`);

  console.log("\n=== 2 & 3. ikeaService + glbGeometryService (real network calls) ===");
  const query = "dining table";
  console.log(`searching IKEA for "${query}"...`);
  const results = await ikeaService.search(query);
  console.log(`found ${results.length} results, first 3:`, results.slice(0, 3).map((r) => `${r.itemNo} ${r.name}`));

  if (results.length === 0) {
    console.error("No search results - can't verify GLB download/measurement.");
    process.exit(1);
  }

  const itemNo = results[0].itemNo;
  console.log(`downloading model for ${itemNo}...`);
  const glbPath = await ikeaService.getModel(itemNo);
  console.log("downloaded to:", glbPath, `(${fs.statSync(glbPath).size} bytes)`);

  const localBox = computeLocalBoundingBox(glbPath);
  const dims = dimensionsCm(localBox);
  console.log(`measured dimensions (cm): ${dims.map((d) => d.toFixed(1)).join(" x ")}`);
  console.log("(sanity: a dining table should print roughly in the 100-200cm range per side, not ~4cm or ~4000cm)");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
