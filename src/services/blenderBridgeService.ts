import { IkeaImportResult, IkeaProduct, IkeaSearchResult, MaterialCatalog, SceneInspection } from "../types/staging.types";

function bridgeUrl() {
  const url = process.env.BLENDER_BRIDGE_URL;
  if (!url) throw new Error("Missing BLENDER_BRIDGE_URL environment variable");
  return url.replace(/\/$/, "");
}

function bridgeHeaders() {
  const apiKey = process.env.BLENDER_BRIDGE_API_KEY;
  if (!apiKey) throw new Error("Missing BLENDER_BRIDGE_API_KEY environment variable");
  return {
    "Content-Type": "application/json",
    "x-bridge-api-key": apiKey,
  };
}

async function parseOrThrow(res: Response, context: string) {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Blender bridge ${context} failed (${res.status}): ${body}`);
  }
  return res.json();
}

/** Import the USDZ on the VM and return a session id plus a description of the scanned room. */
export async function inspectScene(usdzUrl: string): Promise<SceneInspection> {
  const res = await fetch(`${bridgeUrl()}/inspect`, {
    method: "POST",
    headers: bridgeHeaders(),
    body: JSON.stringify({ usdz_url: usdzUrl }),
  });
  return parseOrThrow(res, "inspect") as Promise<SceneInspection>;
}

/** Run an arbitrary bpy script against the session's working .blend file (used for wall/floor material changes). */
export async function executeScript(
  sessionId: string,
  code: string
): Promise<{ output: string; success: boolean }> {
  const res = await fetch(`${bridgeUrl()}/execute`, {
    method: "POST",
    headers: bridgeHeaders(),
    body: JSON.stringify({ session_id: sessionId, code }),
  });
  return parseOrThrow(res, "execute") as Promise<{ output: string; success: boolean }>;
}

/** Live-search IKEA's catalog (ikea.com) for candidate products. */
export async function searchIkea(query: string): Promise<IkeaSearchResult[]> {
  const res = await fetch(`${bridgeUrl()}/ikea/search?${new URLSearchParams({ q: query })}`, {
    headers: bridgeHeaders(),
  });
  return parseOrThrow(res, "ikea/search") as Promise<IkeaSearchResult[]>;
}

/** Fetch the raw IKEA product-info-page JSON for one item (price, style, type, images...). */
export async function getIkeaProduct(itemNo: string): Promise<IkeaProduct> {
  const res = await fetch(`${bridgeUrl()}/ikea/product/${encodeURIComponent(itemNo)}`, {
    headers: bridgeHeaders(),
  });
  return parseOrThrow(res, "ikea/product") as Promise<IkeaProduct>;
}

/**
 * Download an IKEA item's 3D model and import it into the session's scene, optionally
 * deleting whatever currently occupies a slot first (replace) — see /ikea/import in the
 * bridge. replaceObjectNames must be everything CURRENTLY there, not necessarily the
 * original scan object's own name (a slot already replaced once is occupied by the
 * previous import's object_names, which the caller is responsible for tracking).
 */
export async function placeOrReplaceIkeaItem(
  sessionId: string,
  params: {
    itemNo: string;
    position: [number, number, number];
    rotationZDegrees: number;
    replaceObjectNames?: string[];
  }
): Promise<IkeaImportResult> {
  const res = await fetch(`${bridgeUrl()}/ikea/import`, {
    method: "POST",
    headers: bridgeHeaders(),
    body: JSON.stringify({
      session_id: sessionId,
      item_no: params.itemNo,
      position: params.position,
      rotation_z_degrees: params.rotationZDegrees,
      replace_object_names: params.replaceObjectNames ?? null,
    }),
  });
  return parseOrThrow(res, "ikea/import") as Promise<IkeaImportResult>;
}

/** Fetch the curated wall/floor material catalog (floor entries include absolute texture paths on the VM). */
export async function getMaterials(): Promise<MaterialCatalog> {
  const res = await fetch(`${bridgeUrl()}/materials`, { headers: bridgeHeaders() });
  return parseOrThrow(res, "materials") as Promise<MaterialCatalog>;
}

/** Render a preview image of the current scene state. Returns a URL the bridge serves it from. */
export async function renderPreview(sessionId: string): Promise<{ file_url: string }> {
  const res = await fetch(`${bridgeUrl()}/render`, {
    method: "POST",
    headers: bridgeHeaders(),
    body: JSON.stringify({ session_id: sessionId }),
  });
  return parseOrThrow(res, "render") as Promise<{ file_url: string }>;
}

/** Export the final staged scene as USDZ. Returns a URL the bridge serves it from. */
export async function exportScene(sessionId: string): Promise<{ file_url: string }> {
  const res = await fetch(`${bridgeUrl()}/export`, {
    method: "POST",
    headers: bridgeHeaders(),
    body: JSON.stringify({ session_id: sessionId, format: "usdz" }),
  });
  return parseOrThrow(res, "export") as Promise<{ file_url: string }>;
}

/** Download a file the bridge served (from renderPreview/exportScene) so it can be re-uploaded to Supabase storage. */
export async function downloadBridgeFile(fileUrl: string): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await fetch(fileUrl, { headers: bridgeHeaders() });
  if (!res.ok) {
    throw new Error(`Failed to download ${fileUrl} from Blender bridge (${res.status})`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
}
