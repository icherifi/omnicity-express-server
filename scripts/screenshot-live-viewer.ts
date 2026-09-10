import { chromium } from "playwright";

const SCRATCH =
  "C:/Users/asily/AppData/Local/Temp/claude/c--Users-asily-Documents-Projet-Omicity-WebApp-omnicity-express-server/671674f6-c974-4b6c-a506-91315afce592/scratchpad";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(20000);

  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) => errors.push(`[requestfailed] ${req.url()} - ${req.failure()?.errorText}`));

  await page.goto("http://localhost:3000/login", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[name="email"]');
  await page.fill('input[name="email"]', "omnicity.adm@gmail.com");
  await page.fill('input[name="password"]', "OMnicity@06#");
  await page.click('button:has-text("Se connecter")', { force: true });
  await page.waitForTimeout(3000);
  console.log("logged in, URL:", page.url());

  await page.goto("http://localhost:3000/project/89e06845-87d4-47a7-94b1-1ad0b2473072/renovation", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(4000);
  console.log("on renovation page, URL:", page.url());

  // Same PointerEvent-based click this Radix Tabs build needs (plain click is a no-op - see this session's earlier finding).
  await page.evaluate(() => {
    const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((t) =>
      t.textContent?.includes("Aménagement")
    ) as HTMLElement | undefined;
    if (!tab) return;
    const rect = tab.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: rect.x + rect.width / 2,
      clientY: rect.y + rect.height / 2,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    };
    tab.dispatchEvent(new PointerEvent("pointerdown", base));
    tab.dispatchEvent(new MouseEvent("mousedown", base));
    tab.dispatchEvent(new PointerEvent("pointerup", base));
    tab.dispatchEvent(new MouseEvent("mouseup", base));
    tab.dispatchEvent(new MouseEvent("click", base));
  });

  console.log("waiting for staged scene to load...");
  await page.waitForTimeout(10000);
  await page.screenshot({ path: `${SCRATCH}/phase5_live_viewer.png`, fullPage: true });
  console.log("screenshot saved");

  console.log("\n=== ERRORS ===");
  console.log(errors.length ? errors.join("\n") : "(none)");

  await browser.close();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
