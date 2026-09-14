/**
 * Standalone check for furnitureStrippingService.ts against the real fixture:
 * fixed equipment always kept regardless of zone, the zone-scoped storage/
 * cabinet exception, and full coverage (kept ∪ stripped = every object).
 *
 * Run: npx ts-node scripts/verify-furniture-stripping.ts
 */
import fs from "fs";
import path from "path";
import { buildRoomGeometry, inspectRoom } from "../src/services/roomShellService";
import { classifyZones } from "../src/services/roomZoningService";
import { FIXED_EQUIPMENT_CATEGORIES, stripFurniture } from "../src/services/furnitureStrippingService";
import { RoomPlanCapturedRoom } from "../src/types/staging.types";

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  PASS: ${label}`);
  else {
    failures++;
    console.log(`  FAIL: ${label}${detail ? ` (${detail})` : ""}`);
  }
}

const fixturePath = path.join(__dirname, "..", "src", "services", "__fixtures__", "sample-scan.json");
const serialized = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as RoomPlanCapturedRoom;
const inspection = inspectRoom(serialized);
const geometry = buildRoomGeometry(serialized, inspection.room);
const { zones, objectZoneAssignments } = classifyZones(geometry, inspection.sections, inspection.objects);

const { kept, stripped } = stripFurniture(inspection.objects, zones, objectZoneAssignments);
console.log(`\nkept: ${kept.length}, stripped: ${stripped.length}, total objects: ${inspection.objects.length}`);
console.log("kept categories:", kept.map((o) => `${o.object_name}(${o.guessed_category})`));

console.log("\n=== full coverage ===");
check("kept + stripped covers every object exactly once", kept.length + stripped.length === inspection.objects.length);
const keptNames = new Set(kept.map((o) => o.object_name));
const strippedNames = new Set(stripped.map((o) => o.object_name));
check("no object in both kept and stripped", [...keptNames].every((n) => !strippedNames.has(n)));

console.log("\n=== fixed equipment always kept ===");
const fixedEquipmentInFixture = inspection.objects.filter((o) => FIXED_EQUIPMENT_CATEGORIES.has(o.guessed_category));
check("fixture has fixed-equipment objects to test with", fixedEquipmentInFixture.length > 0, `got ${fixedEquipmentInFixture.length}`);
check(
  "every fixed-equipment object is kept",
  fixedEquipmentInFixture.every((o) => keptNames.has(o.object_name)),
  fixedEquipmentInFixture.filter((o) => !keptNames.has(o.object_name)).map((o) => o.object_name).join(", ")
);

console.log("\n=== television is stripped, not fixed ===");
const tvObjects = inspection.objects.filter((o) => o.guessed_category === "television");
check("every television object is stripped", tvObjects.length === 0 || tvObjects.every((o) => strippedNames.has(o.object_name)));

console.log("\n=== zone-scoped storage/cabinet exception ===");
const storageObjects = inspection.objects.filter((o) => o.guessed_category === "storage");
check("fixture has storage objects to test with", storageObjects.length > 0, `got ${storageObjects.length}`);

const zoneById = new Map(zones.map((z) => [z.id, z]));
const storageInKitchenOrBathroom = storageObjects.filter((o) => {
  const zoneId = objectZoneAssignments.get(o.object_name);
  const zone = zoneId ? zoneById.get(zoneId) : undefined;
  return zone && (zone.label === "kitchen" || zone.label === "bathroom");
});
const storageElsewhere = storageObjects.filter((o) => !storageInKitchenOrBathroom.includes(o));

check(
  "storage in a kitchen/bathroom zone is kept",
  storageInKitchenOrBathroom.length === 0 || storageInKitchenOrBathroom.every((o) => keptNames.has(o.object_name)),
  `${storageInKitchenOrBathroom.filter((o) => !keptNames.has(o.object_name)).length} wrongly stripped`
);
check(
  "storage outside kitchen/bathroom is stripped",
  storageElsewhere.length === 0 || storageElsewhere.every((o) => strippedNames.has(o.object_name)),
  `${storageElsewhere.filter((o) => !strippedNames.has(o.object_name)).length} wrongly kept`
);
console.log(`  (${storageInKitchenOrBathroom.length} kitchen/bathroom storage kept, ${storageElsewhere.length} elsewhere stripped)`);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
