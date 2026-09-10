/**
 * Standalone check for Phase 3: calls stagingRenderService.renderPreview()
 * directly against a real fixture, with no Claude involved - isolates "does
 * headless screenshotting work" from "does the tool loop work" (that's Phase 4).
 * Requires espace-client's dev server running on STAGING_RENDER_BASE_URL, and
 * something serving /api/ikea/model/:itemNo at NEXT_PUBLIC_API_BASE_URL (the
 * real server once Phase 4 lands, or scripts/serve-ikea-route.ts until then).
 *
 * Run: npx ts-node scripts/verify-staging-render.ts
 */
import fs from "fs";
import path from "path";
import { StagingRenderSession } from "../src/services/stagingRenderService";
import { RoomPlanCapturedRoom, StagingAction } from "../src/types/staging.types";

const SCRATCH =
  "C:/Users/asily/AppData/Local/Temp/claude/c--Users-asily-Documents-Projet-Omicity-WebApp-omnicity-express-server/671674f6-c974-4b6c-a506-91315afce592/scratchpad";

// Same real object positions used for the Phase 2 manual check (Sink0/Chair0 -
// verified to be in open floor space, not inside a partition wall).
const actions: StagingAction[] = [
  { type: "place", item_no: "70294339", position: [1.35, -1.18, -0.98], rotation_y_degrees: 0 },
  { type: "place", item_no: "70294339", position: [-3.66, -1.18, 6.01], rotation_y_degrees: 90 },
  { type: "wall_color", wall_object_names: "all", material_id: "soft_greige", hex_color: "#E3DCCF" },
  {
    type: "floor_material",
    material_id: "oak_light",
    diffuse_path: "/materials/oak_light/diffuse.jpg",
    normal_path: "/materials/oak_light/normal.jpg",
    roughness_path: "/materials/oak_light/roughness.jpg",
    tile_size_cm: [200, 200],
  },
];

async function main() {
  const fixturePath = path.join(__dirname, "..", "src", "services", "__fixtures__", "sample-scan.json");
  const scanData = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as RoomPlanCapturedRoom;

  const session = new StagingRenderSession();
  try {
    console.log("rendering...");
    const start = Date.now();
    const views = await session.renderPreview({ scanData, actions });
    console.log(`rendered ${views.length} view(s) in ${Date.now() - start}ms`);

    for (const view of views) {
      const outPath = path.join(SCRATCH, `staging_render_phase3_${view.key}.png`);
      fs.writeFileSync(outPath, view.buffer);
      console.log(`saved ${view.key} (${view.buffer.length} bytes) to`, outPath);
    }
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
