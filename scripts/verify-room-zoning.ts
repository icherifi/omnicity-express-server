/**
 * Standalone check for roomZoningService.ts's classifyZones() - the Voronoi-
 * plus-category-refinement algorithm that replaces trusting RoomPlan's sparse
 * `sections[]` labels directly. Covers: the real fixture's known-hard case (a
 * living/dining furniture cluster far from every section), the zero-section/
 * zero-object fallback, and a synthetic multi-bedroom scan.
 *
 * Run: npx ts-node scripts/verify-room-zoning.ts
 */
import fs from "fs";
import path from "path";
import { buildRoomGeometry, inspectRoom, RoomGeometry } from "../src/services/roomShellService";
import { classifyZones } from "../src/services/roomZoningService";
import { RoomPlanCapturedRoom } from "../src/types/staging.types";

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  PASS: ${label}`);
  else {
    failures++;
    console.log(`  FAIL: ${label}${detail ? ` (${detail})` : ""}`);
  }
}

// --- real fixture: the documented hard case -----------------------------------
console.log("\n=== real fixture: living/dining cluster far from every section ===");
const fixturePath = path.join(__dirname, "..", "src", "services", "__fixtures__", "sample-scan.json");
const serialized = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as RoomPlanCapturedRoom;
const inspection = inspectRoom(serialized);
const geometry = buildRoomGeometry(serialized, inspection.room);

const { zones, objectZoneAssignments } = classifyZones(geometry, inspection.sections, inspection.objects);
console.log(
  "  zones:",
  zones.map((z) => `${z.id} (${z.label}, ${z.area_m2.toFixed(1)}m²)`)
);
check("at least 2 zones found (not collapsed to one generic blob)", zones.length >= 2, `got ${zones.length}`);

// The fixture has 3 "sofa"-category objects, not all in the same physical
// cluster - one (confirmed via direct inspection) sits right next to the
// bedroom section and legitimately belongs there. The unambiguous signal is
// the TV and coffee table (singular fixtures of a real living area) plus a
// MAJORITY of the sofas, not "every sofa-category object" (a fixture-specific
// fact, not something the algorithm should be judged against).
const tvObjects = inspection.objects.filter((o) => o.guessed_category === "television");
check("fixture has a TV to test with", tvObjects.length >= 1, `got ${tvObjects.length}`);
const tvZoneId = tvObjects.length > 0 ? objectZoneAssignments.get(tvObjects[0].object_name) : undefined;
const tvZone = zones.find((z) => z.id === tvZoneId);
check("the TV's zone is labeled 'living'", tvZone?.label === "living", `got '${tvZone?.label}'`);

const sofaObjects = inspection.objects.filter((o) => o.guessed_category === "sofa");
check("fixture has at least 2 sofas to test with", sofaObjects.length >= 2, `got ${sofaObjects.length}`);
const sofasInTvZone = sofaObjects.filter((o) => objectZoneAssignments.get(o.object_name) === tvZoneId);
check(
  "a majority of the sofas share the TV's zone",
  sofasInTvZone.length >= Math.ceil(sofaObjects.length / 2),
  `${sofasInTvZone.length}/${sofaObjects.length} in zone ${tvZoneId}`
);

const bedObjects = inspection.objects.filter((o) => o.guessed_category === "bed");
if (bedObjects.length > 0) {
  const bedZoneId = objectZoneAssignments.get(bedObjects[0].object_name);
  const bedZone = zones.find((z) => z.id === bedZoneId);
  check("the bed's zone is labeled 'bedroom'", bedZone?.label === "bedroom", `got '${bedZone?.label}'`);
  check("the bed's zone is NOT the same zone as the TV/living cluster", bedZoneId !== tvZoneId);
}

// --- fallback: zero sections, zero objects -------------------------------------
console.log("\n=== fallback: no sections, no objects ===");
const emptyGeometry: RoomGeometry = {
  walls: [],
  doors: [],
  windows: [],
  wallBoxes: [],
  floorPolygon: [
    [-2, -2],
    [2, -2],
    [2, 2],
    [-2, 2],
  ],
  boundsMin: [-2, 0, -2],
  boundsMax: [2, 2.4, 2],
  zones: [],
};
const emptyResult = classifyZones(emptyGeometry, [], []);
check("exactly one generic zone", emptyResult.zones.length === 1 && emptyResult.zones[0].label === "generic", JSON.stringify(emptyResult.zones));
check("its area matches the floor polygon (16m²)", Math.abs(emptyResult.zones[0].area_m2 - 16) < 0.5, `got ${emptyResult.zones[0].area_m2}`);

// --- synthetic multi-bedroom: two same-labeled sections produce two zones -----
console.log("\n=== synthetic: two 'bedroom' sections -> two distinct zones ===");
const wideGeometry: RoomGeometry = {
  walls: [],
  doors: [],
  windows: [],
  wallBoxes: [],
  floorPolygon: [
    [-6, -2],
    [6, -2],
    [6, 2],
    [-6, 2],
  ],
  boundsMin: [-6, 0, -2],
  boundsMax: [6, 2.4, 2],
  zones: [],
};
const twoBedroomSections: { label: string; center: [number, number, number] }[] = [
  { label: "bedroom", center: [-4, 0, 0] },
  { label: "bedroom", center: [4, 0, 0] },
];
const twoBedroomResult = classifyZones(wideGeometry, twoBedroomSections, []);
console.log(
  "  zones:",
  twoBedroomResult.zones.map((z) => `${z.id} (${z.label})`)
);
// The two sections are 8m apart on a 12m-wide floor - farther apart than twice
// the section-claim radius, so the middle legitimately becomes its own
// unclaimed zone (exactly like a real hallway between two bedrooms would) -
// assert on the bedroom zones specifically, not the total zone count.
const bedroomZones = twoBedroomResult.zones.filter((z) => z.label === "bedroom");
check("exactly two bedroom-labeled zones", bedroomZones.length === 2, `got ${bedroomZones.length}`);
check("their ids are distinct", bedroomZones.length === 2 && bedroomZones[0].id !== bedroomZones[1].id);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
