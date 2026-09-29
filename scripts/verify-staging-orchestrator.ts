/**
 * Real end-to-end check of the manifest-driven redesign: calls runStaging()
 * directly against the real fixture (no HTTP layer, no Supabase auth needed) -
 * the full Claude tool-use loop, zone classification, furniture stripping,
 * two-phase placement, hard-constraint validation, and review_layout gate, all
 * for real. Costs real Claude API tokens.
 *
 * Requires espace-client's dev server running on STAGING_RENDER_BASE_URL.
 *
 * Run: npx ts-node scripts/verify-staging-orchestrator.ts
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { runStaging } from "../src/services/stagingOrchestratorService";
import { RoomPlanCapturedRoom, StagingAction } from "../src/types/staging.types";

const SCRATCH =
  "C:/Users/asily/AppData/Local/Temp/claude/c--Users-asily-Documents-Projet-Omicity-WebApp-omnicity-express-server/671674f6-c974-4b6c-a506-91315afce592/scratchpad";

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`PASS: ${label}`);
  else {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`);
  }
}

async function main() {
  const fixturePath = path.join(__dirname, "..", "src", "services", "__fixtures__", "sample-scan.json");
  const serialized = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as RoomPlanCapturedRoom;

  console.log("running full staging orchestration (real Claude API calls)...");
  const start = Date.now();
  const { summary, previewBuffer } = await runStaging(serialized);
  console.log(`done in ${((Date.now() - start) / 1000).toFixed(0)}s`);

  console.log("\n=== NOTES ===");
  console.log(summary.notes);

  console.log("\n=== ACTIONS ===");
  for (const action of summary.actions) {
    console.log(JSON.stringify(action));
  }

  console.log("\n=== ERRORS ===");
  console.log(summary.errors.length > 0 ? summary.errors.join("\n") : "(none)");

  const outPath = path.join(SCRATCH, "staging_orchestrator_final.png");
  fs.writeFileSync(outPath, previewBuffer);
  console.log("\nsaved final preview to", outPath);

  console.log("\n=== CHECKS ===");
  const placeActions = summary.actions.filter((a): a is Extract<StagingAction, { type: "place" }> => a.type === "place");
  check("at least one manifest item was placed", placeActions.length > 0, `got ${placeActions.length}`);

  const wallColorAction = summary.actions.find((a): a is Extract<StagingAction, { type: "wall_color" }> => a.type === "wall_color");
  const floorMaterialAction = summary.actions.find((a): a is Extract<StagingAction, { type: "floor_material" }> => a.type === "floor_material");
  check(
    "wall color is the exact programmatic default (soft_greige)",
    wallColorAction?.material_id === "soft_greige",
    `got '${wallColorAction?.material_id}'`
  );
  check(
    "floor material is the exact programmatic default (oak_light)",
    floorMaterialAction?.material_id === "oak_light",
    `got '${floorMaterialAction?.material_id}'`
  );

  check(
    "stripped_roomplan_identifiers is non-empty (this fixture has plenty of strippable furniture)",
    summary.stripped_roomplan_identifiers.length > 0,
    `got ${summary.stripped_roomplan_identifiers.length}`
  );

  // Phase ordering proxy: every relative_to placement's target_id must already
  // be a slot_id from an EARLIER action in the persisted list - proves
  // independent-anchor slots were genuinely placed before any dependent slot
  // that targets them, not just that the solver would have rejected the
  // opposite order (which is already covered by verify-placement-solver.ts).
  const seenSlotIds = new Set<string>();
  let orderingViolation: string | null = null;
  for (const action of placeActions) {
    if (action.intent?.anchor.kind === "relative_to") {
      const targetId = action.intent.anchor.target_id;
      if (!seenSlotIds.has(targetId)) {
        orderingViolation = `${action.slot_id} (relative_to ${targetId}) placed before ${targetId} existed`;
        break;
      }
    }
    seenSlotIds.add(action.slot_id);
  }
  check("every relative_to placement's target was already placed (phase A before phase B held)", orderingViolation === null, orderingViolation ?? undefined);

  check("run completed with no unexpected errors", summary.errors.length === 0, summary.errors.join("; "));

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
