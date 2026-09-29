/**
 * Ported from blender-bridge/ikea_lib.py, vendored (c) 2024 Shish from
 * https://github.com/shish/blender-ikea-browser, GPL-3.0-or-later (SPDX).
 * This file is a derivative work of that GPL-licensed original and stays
 * under the same license — see https://www.gnu.org/licenses/gpl-3.0.txt
 * before distributing this outside internal use.
 *
 * Talks to ikea.com's undocumented internal APIs directly (no official IKEA
 * API involved). IKEA still owns the copyright on the 3D models this
 * returns — this is a decision for whoever owns this project to make
 * explicitly (get IKEA's sign-off, restrict to internal mockups, or switch
 * to a licensed asset library) before shipping staged renders built from
 * these models to end users or clients.
 */

import fs from "fs";
import path from "path";
import { IkeaProduct, IkeaSearchResult } from "../types/staging.types";

const CLIENT_ID = "4863e7d2-1428-4324-890b-ae5dede24fc6";
const USER_AGENT = "Blender IKEA Browser ( https://github.com/shish/blender-ikea-browser/ )";

const COUNTRY = process.env.IKEA_COUNTRY || "fr";
const LANGUAGE = process.env.IKEA_LANGUAGE || "fr";
const CACHE_DIR = path.resolve(process.env.IKEA_CACHE_DIR || "ikea_cache");

class IkeaException extends Error {}

function isItemNo(itemNo: string): boolean {
  return /^\d{3}\.?\d{3}\.?\d{2}$/.test(itemNo);
}

async function getJson<T>(url: string, params: Record<string, string> = {}): Promise<T> {
  const fullUrl = new URL(url);
  for (const [k, v] of Object.entries(params)) fullUrl.searchParams.set(k, v);

  const headers: Record<string, string> = {};
  if (fullUrl.hostname === "web-api.ikea.com") {
    headers["X-Client-Id"] = CLIENT_ID;
    headers["User-Agent"] = USER_AGENT;
  }

  let resp: Response;
  try {
    resp = await fetch(fullUrl.toString(), { headers, signal: AbortSignal.timeout(15_000) });
  } catch (e: any) {
    throw new IkeaException(`Error fetching ${fullUrl}: ${e?.message ?? e}`);
  }
  if (!resp.ok) throw new IkeaException(`HTTP Error ${resp.status}: ${resp.statusText}`);
  return (await resp.json()) as T;
}

function cachePath(itemNo: string, filename: string): string {
  return path.join(CACHE_DIR, itemNo, filename);
}

async function readCache<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function writeCache(filePath: string, data: string | Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, data);
}

export async function search(query: string): Promise<IkeaSearchResult[]> {
  const url = `https://sik.search.blue.cdtapps.com/${COUNTRY}/${LANGUAGE}/search-result-page`;
  const params: Record<string, string> = { types: "PRODUCT", q: query, size: "24", c: "sr", v: "20210322" };
  if (isItemNo(query)) {
    params.size = "1";
  } else {
    params.autocorrect = "true";
    params["subcategories-style"] = "tree-navigation";
  }

  let searchResults: any;
  try {
    searchResults = await getJson(url, params);
  } catch (e: any) {
    throw new IkeaException(`Error searching for ${query}: ${e?.message ?? e}`);
  }

  const items: any[] = searchResults?.searchResultPage?.products?.main?.items ?? [];
  const results: IkeaSearchResult[] = [];

  for (const i of items) {
    const p = i.product;
    let valid = true;
    for (const field of ["itemNo", "mainImageUrl", "mainImageAlt", "pipUrl"]) {
      if (!(field in p)) valid = false;
    }
    if (valid && !(await getExists(p.itemNo))) valid = false;

    if (valid) {
      results.push({
        itemNo: p.itemNo,
        name: p.name,
        mainImageUrl: p.mainImageUrl,
        mainImageAlt: p.mainImageAlt,
        pipUrl: p.pipUrl,
      });
    }
  }

  return results;
}

export async function getProduct(itemNo: string): Promise<IkeaProduct> {
  const cache = cachePath(itemNo, "pip.json");
  const cached = await readCache<IkeaProduct>(cache);
  if (cached) return cached;

  try {
    const url = `https://www.ikea.com/${COUNTRY}/${LANGUAGE}/products/${itemNo.slice(5)}/${itemNo}.json`;
    const data = await getJson<IkeaProduct>(url);
    await writeCache(cache, JSON.stringify(data));
    return data;
  } catch (e: any) {
    throw new IkeaException(`Error downloading PIP for #${itemNo}: ${e?.message ?? e}`);
  }
}

async function getExists(itemNo: string): Promise<boolean> {
  const cache = cachePath(itemNo, "exists.json");
  const cached = await readCache<{ exists: boolean }>(cache);
  if (cached) return cached.exists;

  try {
    const data = await getJson<{ exists: boolean }>(
      `https://web-api.ikea.com/${COUNTRY}/${LANGUAGE}/rotera/data/exists/${itemNo}/`
    );
    await writeCache(cache, JSON.stringify(data));
    return data.exists;
  } catch (e: any) {
    throw new IkeaException(`Error checking model existence for #${itemNo}: ${e?.message ?? e}`);
  }
}

/** Downloads (and caches) the GLB for an item, returning its local file path. */
export async function getModel(itemNo: string): Promise<string> {
  const cache = cachePath(itemNo, "model.glb");
  if (fs.existsSync(cache)) return cache;

  try {
    if (!(await getExists(itemNo))) throw new IkeaException(`No model available for #${itemNo}`);

    const roteraData = await getJson<{ modelUrl: string }>(
      `https://web-api.ikea.com/${COUNTRY}/${LANGUAGE}/rotera/data/model/${itemNo}/`
    );
    const resp = await fetch(roteraData.modelUrl, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) throw new IkeaException(`HTTP Error ${resp.status} downloading model`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    await writeCache(cache, buffer);
    return cache;
  } catch (e: any) {
    throw new IkeaException(`Error downloading model for #${itemNo}: ${e?.message ?? e}`);
  }
}

export { IkeaException };
