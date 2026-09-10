/**
 * Drives a headless Playwright browser to screenshot the actual live
 * StagedSceneRenderer component (via espace-client's hidden /internal/
 * staging-render route) - not a separate renderer, so Claude's self-check
 * during planning sees exactly what real users will see. Replaces Blender/
 * EEVEE for this purpose.
 */

import { Browser, chromium, Page } from "playwright";
import { RoomPlanCapturedRoom, StagingAction } from "../types/staging.types";

const RENDER_BASE_URL = (process.env.STAGING_RENDER_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const PAYLOAD_URL_PATTERN = "**/internal/staging-render/payload";
const RENDER_TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 800 };

export interface RenderPayload {
  scanData: RoomPlanCapturedRoom;
  actions: StagingAction[];
}

/**
 * One browser instance per staging run (not per render call - Claude may call
 * render_preview several times in one tool loop; a fresh browser process per
 * call would be needlessly slow). Call close() once the run is done.
 */
export class StagingRenderSession {
  private browser: Browser | null = null;

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) this.browser = await chromium.launch();
    return this.browser;
  }

  async renderPreview(payload: RenderPayload): Promise<Buffer> {
    const browser = await this.ensureBrowser();
    const page: Page = await browser.newPage({ viewport: VIEWPORT });
    try {
      await page.route(PAYLOAD_URL_PATTERN, (route) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) })
      );
      await page.goto(`${RENDER_BASE_URL}/internal/staging-render`, {
        waitUntil: "domcontentloaded",
        timeout: RENDER_TIMEOUT_MS,
      });
      // A broken model/texture still resolves this (StagedSceneRenderer's error
      // boundaries count a failed load as "settled"), so this never hangs on one
      // bad IKEA item - only a total page-level failure would time out here.
      await page.waitForSelector('[data-render-ready="true"]', { timeout: RENDER_TIMEOUT_MS });
      return await page.screenshot();
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
