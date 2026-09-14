/**
 * One-time asset onboarding tool: converts an OBJ(+MTL) model - or recenters
 * an already-GLB one - via espace-client's /internal/convert-model page,
 * driven headlessly (the same house pattern stagingRenderService.ts uses for
 * real renders), measures it through the exact pipeline every placement uses,
 * and uploads the result to Supabase Storage (this project's established
 * persistent storage - see src/handlers/staging.ts's own upload() call for
 * the pattern this mirrors).
 *
 * Run: npx ts-node scripts/onboard-local-model.ts <model_id> <path/to/model.obj> [path/to/model.mtl]
 * Run: npx ts-node scripts/onboard-local-model.ts <model_id> <path/to/model.glb>
 * Example: npx ts-node scripts/onboard-local-model.ts mi_smart_tv "C:/Users/asily/Documents/Projet_Omicity/Models/32-fbxobj-formats/MI SMART TV.obj" "C:/Users/asily/Documents/Projet_Omicity/Models/32-fbxobj-formats/MI SMART TV.mtl"
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { computeLocalBoundingBox, dimensionsCm } from "../src/services/glbGeometryService";
import { LOCAL_MODELS_BUCKET, localModelStoragePath } from "../src/services/localModelService";

const RENDER_BASE_URL = (process.env.STAGING_RENDER_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const PAYLOAD_URL_PATTERN = "**/internal/convert-model/payload";

type ConvertInput = { objText: string; mtlText?: string } | { glbBase64: string };

async function convertToGlb(input: ConvertInput): Promise<{ glb: Buffer; previewPng: Buffer | null }> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.route(PAYLOAD_URL_PATTERN, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(input) })
    );
    await page.goto(`${RENDER_BASE_URL}/internal/convert-model`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector('[data-conversion-ready="true"]', { timeout: 120_000 });

    const error = await page.evaluate(() => document.documentElement.dataset.conversionError);
    if (error) throw new Error(`conversion failed in-browser: ${error}`);

    const base64 = await page.evaluate(() => (window as unknown as { __CONVERTED_GLB_BASE64__?: string }).__CONVERTED_GLB_BASE64__);
    if (!base64) throw new Error("conversion page reported ready but produced no GLB data");

    const previewBase64 = await page.evaluate(() => (window as unknown as { __PREVIEW_PNG_BASE64__?: string }).__PREVIEW_PNG_BASE64__);
    const previewPng = previewBase64 ? Buffer.from(previewBase64, "base64") : null;

    return { glb: Buffer.from(base64, "base64"), previewPng };
  } finally {
    await page.close();
    await browser.close();
  }
}

async function main() {
  const [modelId, sourcePath, mtlPath] = process.argv.slice(2);
  if (!modelId || !sourcePath) {
    console.error("Usage: npx ts-node scripts/onboard-local-model.ts <model_id> <path/to/model.obj|model.glb> [path/to/model.mtl]");
    process.exit(1);
  }

  const isGlb = sourcePath.toLowerCase().endsWith(".glb");
  let input: ConvertInput;
  if (isGlb) {
    console.log(`reading ${sourcePath} (already GLB - will still recenter/preview, just skips OBJ/MTL parsing)...`);
    input = { glbBase64: fs.readFileSync(sourcePath).toString("base64") };
  } else {
    console.log(`reading ${sourcePath}${mtlPath ? ` + ${mtlPath}` : ""}...`);
    const objText = fs.readFileSync(sourcePath, "utf-8");
    const mtlText = mtlPath ? fs.readFileSync(mtlPath, "utf-8") : undefined;
    input = { objText, mtlText };
  }

  console.log("converting to GLB (headless browser)...");
  const { glb: glbBuffer, previewPng } = await convertToGlb(input);
  console.log(`converted: ${glbBuffer.length} bytes`);

  const scratchDir = process.env.CLAUDE_SCRATCHPAD_DIR || require("os").tmpdir();
  const scratchGlbPath = path.join(scratchDir, `${modelId}.glb`);
  fs.writeFileSync(scratchGlbPath, glbBuffer);
  const localBox = computeLocalBoundingBox(scratchGlbPath);
  const [w, h, d] = dimensionsCm(localBox);
  console.log(`measured dimensions: ${w.toFixed(1)} x ${h.toFixed(1)} x ${d.toFixed(1)} cm (w x h x d)`);
  console.log(`local box min/max (should have min.y ~= 0, confirming origin-at-base):`, localBox);

  if (previewPng) {
    const previewPath = path.join(scratchDir, `${modelId}-preview.png`);
    fs.writeFileSync(previewPath, previewPng);
    console.log(`preview screenshot saved: ${previewPath}`);
  } else {
    console.log("WARNING: no preview screenshot was produced (page may predate renderPreview())");
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseKey);

  const storagePath = localModelStoragePath(modelId);
  console.log(`uploading to Supabase Storage: ${LOCAL_MODELS_BUCKET}/${storagePath}...`);
  const { error: uploadError } = await supabase.storage
    .from(LOCAL_MODELS_BUCKET)
    .upload(storagePath, glbBuffer, { contentType: "model/gltf-binary", upsert: true });
  if (uploadError) throw uploadError;

  console.log(`\nDone. Use item_no: "${modelId}", model_source: "local" in a roomManifests.ts slot.`);
  console.log(`Measured dimensions_cm: [${w.toFixed(1)}, ${h.toFixed(1)}, ${d.toFixed(1)}]`);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
