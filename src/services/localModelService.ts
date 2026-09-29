/**
 * Non-IKEA 3D models used by the staging manifest (see roomManifests.ts's
 * model_source: "local") - real items IKEA simply doesn't sell, a TV being the
 * first case. Mirrors ikeaService.ts's getModel() shape exactly (local disk
 * cache first, else fetch-and-cache) so resolveAndValidate can treat both
 * sources uniformly - only the fetch source differs: Supabase Storage (this
 * project's established persistent storage, see src/handlers/staging.ts's own
 * upload() call) instead of a third-party CDN. Assets are onboarded once via
 * scripts/onboard-local-model.ts, which converts + uploads them; this service
 * only ever reads.
 */

import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const CACHE_DIR = path.resolve(process.env.LOCAL_MODEL_CACHE_DIR || "local_model_cache");
/** Reuses the existing private "documents" bucket under its own path prefix,
 * rather than provisioning a new bucket - same RLS/service-role story as
 * every other server-side upload in this codebase. */
export const LOCAL_MODELS_BUCKET = "documents";

export function localModelStoragePath(modelId: string): string {
  return `local-models/${modelId}/model.glb`;
}

function cachePath(modelId: string): string {
  return path.join(CACHE_DIR, modelId, "model.glb");
}

function supabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY environment variables");
  return createClient(url, key);
}

export async function getModel(modelId: string): Promise<string> {
  const cache = cachePath(modelId);
  if (fs.existsSync(cache)) return cache;

  const supabase = supabaseClient();
  const storagePath = localModelStoragePath(modelId);
  const { data, error } = await supabase.storage.from(LOCAL_MODELS_BUCKET).download(storagePath);
  if (error || !data) {
    throw new Error(`Error downloading local model '${modelId}' (${LOCAL_MODELS_BUCKET}/${storagePath}): ${error?.message ?? "no data returned"}`);
  }

  const buffer = Buffer.from(await data.arrayBuffer());
  await fs.promises.mkdir(path.dirname(cache), { recursive: true });
  await fs.promises.writeFile(cache, buffer);
  return cache;
}
