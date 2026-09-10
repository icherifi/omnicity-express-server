/** One-off: confirm a nonexistent item_no doesn't hang the render forever. */
import fs from "fs";
import path from "path";
import { StagingRenderSession } from "../src/services/stagingRenderService";
import { RoomPlanCapturedRoom, StagingAction } from "../src/types/staging.types";

const SCRATCH =
  "C:/Users/asily/AppData/Local/Temp/claude/c--Users-asily-Documents-Projet-Omicity-WebApp-omnicity-express-server/671674f6-c974-4b6c-a506-91315afce592/scratchpad";

const actions: StagingAction[] = [
  { type: "place", instance_name: "bogus_item", item_no: "99999999", position: [1.35, -1.18, -0.98], rotation_y_degrees: 0 }, // deliberately bogus
  { type: "place", instance_name: "real_item", item_no: "70294339", position: [-3.66, -1.18, 6.01], rotation_y_degrees: 90 }, // real, should still render
];

async function main() {
  const fixturePath = path.join(__dirname, "..", "src", "services", "__fixtures__", "sample-scan.json");
  const scanData = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as RoomPlanCapturedRoom;

  const session = new StagingRenderSession();
  try {
    const start = Date.now();
    const views = await session.renderPreview({ scanData, actions });
    console.log(`rendered ${views.length} view(s) in ${Date.now() - start}ms despite one broken item`);
    for (const view of views) {
      console.log(`  ${view.key}: ${view.buffer.length} bytes`);
      fs.writeFileSync(path.join(SCRATCH, `staging_render_broken_${view.key}.png`), view.buffer);
    }
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error("FATAL - render hung or crashed instead of degrading gracefully:", e);
  process.exit(1);
});
