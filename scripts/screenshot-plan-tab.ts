import { chromium } from "playwright";

const SCRATCH =
  "C:/Users/asily/AppData/Local/Temp/claude/c--Users-asily-Documents-Projet-Omicity-WebApp-omnicity-express-server/671674f6-c974-4b6c-a506-91315afce592/scratchpad";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(20000);

  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));

  await page.goto("http://localhost:3000/login", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[name="email"]');
  await page.fill('input[name="email"]', "omnicity.adm@gmail.com");
  await page.fill('input[name="password"]', "OMnicity@06#");
  await page.click('button:has-text("Se connecter")', { force: true });
  await page.waitForTimeout(3000);

  await page.goto("http://localhost:3000/project/89e06845-87d4-47a7-94b1-1ad0b2473072/renovation", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(4000);
  // Default tab is already "Plan" - just screenshot without touching tabs.
  await page.screenshot({ path: `${SCRATCH}/phase5_plan_tab.png`, fullPage: true });
  console.log("screenshot saved");
  console.log("errors:", errors.length ? errors.join("\n") : "(none)");

  await browser.close();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
