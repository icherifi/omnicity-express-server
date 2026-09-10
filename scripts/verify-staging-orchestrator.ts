/**
 * Real end-to-end check of the Phase 3 rewrite: calls runStaging() directly
 * against the real fixture (no HTTP layer, no Supabase auth needed) - the full
 * Claude tool-use loop, intent-based solver, hard/soft constraints, and
 * review_layout gate, all for real. Costs real Claude API tokens.
 *
 * Requires espace-client's dev server running on STAGING_RENDER_BASE_URL.
 *
 * Run: npx ts-node scripts/verify-staging-orchestrator.ts
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { runStaging } from "../src/services/stagingOrchestratorService";
import { RoomPlanCapturedRoom } from "../src/types/staging.types";

const SCRATCH =
  "C:/Users/asily/AppData/Local/Temp/claude/c--Users-asily-Documents-Projet-Omicity-WebApp-omnicity-express-server/671674f6-c974-4b6c-a506-91315afce592/scratchpad";

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

  const placeOrReplaceCount = summary.actions.filter((a) => a.type === "place" || a.type === "replace").length;
  const hasWallColor = summary.actions.some((a) => a.type === "wall_color");
  const hasFloorMaterial = summary.actions.some((a) => a.type === "floor_material");
  console.log(`\nplace/replace actions: ${placeOrReplaceCount}, wall_color: ${hasWallColor}, floor_material: ${hasFloorMaterial}`);

  if (!hasWallColor || !hasFloorMaterial || placeOrReplaceCount === 0) {
    console.error("FAIL: expected at least one furniture action, a wall color, and a floor material");
    process.exit(1);
  }
  console.log("PASS: run completed with the expected mandatory actions present");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
