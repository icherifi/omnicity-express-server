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
// A cold Next.js dev-mode compile of this route (heavy Three.js/drei bundle,
// two Canvas mounts) on the very first hit after a dev-server restart can alone
// take longer than 30s, independent of anything actually slow at runtime -
// confirmed directly: a fresh dev server's first render call timed out at 30s
// navigating, while every call after the route was warm completed well within
// it. Generous enough to absorb that one-time cost without masking a genuinely
// hung render.
const RENDER_TIMEOUT_MS = 60_000;
// Wide enough for the 2-column top-down + perspective grid, each view still a
// reasonable individual frame.
const VIEWPORT = { width: 2000, height: 900 };

export interface RenderPayload {
  scanData: RoomPlanCapturedRoom;
  actions: StagingAction[];
}

export interface RenderedView {
  key: string;
  buffer: Buffer;
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

  /** One screenshot per rendered view (today: a top-down plan view + an eye-level
   * perspective view - see stagingCameraViews.ts on the frontend). Cropping to
   * each view is just Playwright's per-element screenshot, no manual pixel math. */
  async renderPreview(payload: RenderPayload): Promise<RenderedView[]> {
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

      const elements = await page.locator("[data-view]").all();
      const views: RenderedView[] = [];
      for (const el of elements) {
        const key = (await el.getAttribute("data-view")) ?? `view-${views.length}`;
        // Without an explicit timeout this falls back to Playwright's own 30s
        // action default, independent of RENDER_TIMEOUT_MS above - too tight for
        // a heavily-furnished room (20+ GLBs across two Canvas mounts genuinely
        // takes a while for Chromium to settle), confirmed directly by a real
        // run timing out here on a large real layout.
        views.push({ key, buffer: await el.screenshot({ timeout: RENDER_TIMEOUT_MS }) });
      }
      return views;
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
