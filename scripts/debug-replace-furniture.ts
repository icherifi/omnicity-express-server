/** Diagnostic: calls handleReplaceFurniture directly (no Claude) for a real
 * scanned object with a real IKEA item, no intent - reproduces and explains
 * why so many no-intent replace_furniture calls were rejected in a real run. */
import fs from "fs";
import path from "path";
import { buildRoomGeometry, inspectRoom } from "../src/services/roomShellService";
import { getMaterials } from "../src/services/materialsService";
import { StagingRenderSession } from "../src/services/stagingRenderService";
import { PlacedItem, RunState, StagingContext } from "../src/services/stagingState";
import { handleReplaceFurniture } from "../src/services/stagingToolHandlers";
import { RoomPlanCapturedRoom } from "../src/types/staging.types";

async function main() {
  const fixturePath = path.join(__dirname, "..", "src", "services", "__fixtures__", "sample-scan.json");
  const serialized = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as RoomPlanCapturedRoom;
  const inspection = inspectRoom(serialized);
  const geometry = buildRoomGeometry(serialized, inspection.room);
  const materials = getMaterials();
  const objectsByName = new Map(inspection.objects.map((o) => [o.object_name, o]));

  const slots = new Map<string, PlacedItem>();
  for (const obj of inspection.objects) {
    const [w, h, d] = obj.dimensions_cm.map((cm) => cm / 100);
    slots.set(obj.object_name, {
      itemNo: "",
      localBox: { min: [-w / 2, -h / 2, -d / 2], max: [w / 2, h / 2, d / 2] },
      position: obj.position,
      rotationYDegrees: obj.rotation_y_degrees,
      sourceKind: "original_scan",
    });
  }
  const state: RunState = { hasSetWallColor: false, hasSetFloorMaterial: false, lastReviewClean: false, slots };
  const ctx: StagingContext = {
    serialized,
    objectsByName,
    materials,
    floorY: inspection.room.bounds_min[1],
    geometry,
    renderSession: new StagingRenderSession(),
    actions: [],
    errors: [],
    state,
  };

  // Real object_name/item_no pairs Claude actually tried in the failed run.
  const cases: Array<{ object_name: string; item_no: string }> = [
    { object_name: "Chair0", item_no: "00457235" },
    { object_name: "Bed0", item_no: "79241290" },
    { object_name: "Sofa0", item_no: "69509010" },
    { object_name: "Storage1", item_no: "70326788" },
    { object_name: "Table0", item_no: "70294339" },
  ];

  for (const c of cases) {
    const original = objectsByName.get(c.object_name)!;
    console.log(`\n=== ${c.object_name} (original dims_cm=${JSON.stringify(original.dimensions_cm)}, pos=${JSON.stringify(original.position)}) ===`);
    const result = await handleReplaceFurniture({ object_name: c.object_name, item_no: c.item_no }, ctx);
    console.log(result);
  }

  await ctx.renderSession.close();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
