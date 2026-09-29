/**
 * Standing regression check for src/staging/roomManifests.ts: every distinct
 * item_no across every archetype must actually download and measure to a
 * plausible, non-degenerate bounding box via the real ikeaService/
 * glbGeometryService pipeline (the same one every real placement uses) - a
 * discontinued or typo'd item_no should fail loudly here, not mid-run.
 *
 * Run: npx ts-node scripts/verify-manifest-config.ts
 */
import "dotenv/config"; // needed now that local-sourced items (see localModelService.ts) require Supabase credentials
import * as ikeaService from "../src/services/ikeaService";
import * as localModelService from "../src/services/localModelService";
import * as glbGeometryService from "../src/services/glbGeometryService";
import { selectAndFlattenManifests } from "../src/staging/roomManifests";
import { Zone } from "../src/services/roomShellService";

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  PASS: ${label}`);
  else {
    failures++;
    console.log(`  FAIL: ${label}${detail ? ` (${detail})` : ""}`);
  }
}

// One synthetic zone per archetype-triggering label/area, to pull every
// archetype's slots out of selectAndFlattenManifests in one pass.
const SYNTHETIC_ZONES: Zone[] = [
  { id: "zone_bedroom_1", label: "bedroom", centroid: [0, 0], area_m2: 12, bounds_min: [-2, -2], bounds_max: [2, 2] },
  { id: "zone_living_0", label: "living", centroid: [0, 10], area_m2: 6.3, bounds_min: [-2, 8], bounds_max: [2, 12] }, // under compact threshold -> living_room_compact
  { id: "zone_living_1", label: "living", centroid: [10, 0], area_m2: 15, bounds_min: [8, -2], bounds_max: [12, 2] }, // under dining threshold -> living_room
  { id: "zone_living_2", label: "living", centroid: [20, 0], area_m2: 25, bounds_min: [17, -3], bounds_max: [23, 3] }, // over threshold -> living_dining
];

async function main() {
  const slots = selectAndFlattenManifests(SYNTHETIC_ZONES);
  console.log(`\n${slots.length} flattened slots across ${SYNTHETIC_ZONES.length} synthetic zones`);

  console.log("\n=== small-zone tier: the too-small living zone gets only the armchair ===");
  const compactSlots = slots.filter((s) => s.zone_id === "zone_living_0");
  check(
    "exactly one slot (armchair) for the 6.3m² zone",
    compactSlots.length === 1 && compactSlots[0].category === "armchair",
    JSON.stringify(compactSlots.map((s) => s.category))
  );

  console.log("\n=== slot_id uniqueness ===");
  const seen = new Set<string>();
  const duplicates = slots.filter((s) => (seen.has(s.slot_id) ? true : (seen.add(s.slot_id), false)));
  check("every slot_id is unique across the whole flattened set", duplicates.length === 0, duplicates.map((s) => s.slot_id).join(", "));

  console.log("\n=== depends_on_slot_id resolves to a real slot in the same zone ===");
  const slotIds = new Set(slots.map((s) => s.slot_id));
  const dependents = slots.filter((s) => s.anchor_category === "dependent");
  check("at least one dependent slot exists to test with", dependents.length > 0, `got ${dependents.length}`);
  const badDeps = dependents.filter((s) => !s.depends_on_slot_id || !slotIds.has(s.depends_on_slot_id));
  check("every dependent slot's depends_on_slot_id points to a real slot_id", badDeps.length === 0, badDeps.map((s) => s.slot_id).join(", "));

  console.log("\n=== every unique item_no downloads and measures to a sane bounding box ===");
  const uniqueItemNos = [...new Set(slots.map((s) => s.item_no))];
  console.log(`${uniqueItemNos.length} unique item_no(s) across ${slots.length} slots`);
  for (const itemNo of uniqueItemNos) {
    // Route by model_source, same as prefetchDimensionsByItemNo in
    // stagingOrchestratorService.ts - a "local" id (e.g. a TV) is meaningless
    // to ikeaService.getModel and would throw. This exact mismatch was caught
    // here (real bug, fixed alongside this check): the orchestrator's own
    // prefetch used to call ikeaService.getModel unconditionally too, which
    // would have hard-failed every run whose manifest included a local model.
    const modelSource = slots.find((s) => s.item_no === itemNo)?.model_source ?? "ikea";
    try {
      const glbPath = modelSource === "local" ? await localModelService.getModel(itemNo) : await ikeaService.getModel(itemNo);
      const box = glbGeometryService.computeLocalBoundingBox(glbPath);
      const [w, h, d] = glbGeometryService.dimensionsCm(box);
      const plausible = w > 5 && w < 400 && h > 5 && h < 250 && d > 5 && d < 400;
      console.log(`  ${itemNo} (${modelSource}): ${w.toFixed(0)}x${h.toFixed(0)}x${d.toFixed(0)}cm`);
      check(`${itemNo} measures to a plausible furniture-sized bounding box`, plausible, `${w.toFixed(0)}x${h.toFixed(0)}x${d.toFixed(0)}cm`);
    } catch (e) {
      check(`${itemNo} (${modelSource}) downloads and measures without error`, false, (e as Error).message);
    }
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
