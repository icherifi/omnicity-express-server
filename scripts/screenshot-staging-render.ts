import { chromium } from "playwright";

const SCRATCH =
  "C:/Users/asily/AppData/Local/Temp/claude/c--Users-asily-Documents-Projet-Omicity-WebApp-omnicity-express-server/671674f6-c974-4b6c-a506-91315afce592/scratchpad";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.setDefaultTimeout(20000);

  const logs: string[] = [];
  page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) => logs.push(`[requestfailed] ${req.url()} - ${req.failure()?.errorText}`));

  console.log("navigating...");
  await page.goto("http://localhost:3000/internal/staging-render", { waitUntil: "domcontentloaded" });
  console.log("waiting for scene to settle...");
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `${SCRATCH}/staging_render_phase2.png` });
  console.log("screenshot saved");

  console.log("\n=== LOGS ===");
  console.log(logs.join("\n"));

  await browser.close();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
