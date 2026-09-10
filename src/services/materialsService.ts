/**
 * Reads the curated CC0 (Poly Haven) floor materials + wall paint colors catalog.
 * The manifest itself (src/materials/manifest.json, moved from the old
 * blender-bridge/materials/) only stores relative filenames per material; this
 * resolves them to root-relative URLs matching where the actual JPGs are served
 * from on the frontend (espace-client/public/materials/...), since these paths
 * now feed a browser-side THREE.TextureLoader, not a filesystem path for Blender.
 */

import fs from "fs";
import path from "path";
import { FloorMaterial, MaterialCatalog, WallMaterial } from "../types/staging.types";

// process.cwd()-relative, not __dirname-relative: __dirname would point into
// dist/ under a compiled build, and this JSON file (unlike .ts sources) isn't
// something tsc copies there. Same convention ikeaService.ts's CACHE_DIR uses.
const MANIFEST_PATH = path.resolve(process.cwd(), "src", "materials", "manifest.json");

interface RawFloorEntry {
  material_id: string;
  name: string;
  source: string;
  diffuse: string;
  normal: string;
  roughness: string;
  tile_size_cm: [number, number];
}

interface RawManifest {
  floors: RawFloorEntry[];
  walls: WallMaterial[];
}

export function getMaterials(): MaterialCatalog {
  const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")) as RawManifest;

  const floors: FloorMaterial[] = raw.floors.map((f) => ({
    material_id: f.material_id,
    name: f.name,
    source: f.source,
    diffuse_path: `/materials/${f.diffuse}`,
    normal_path: `/materials/${f.normal}`,
    roughness_path: `/materials/${f.roughness}`,
    tile_size_cm: f.tile_size_cm,
  }));

  return { floors, walls: raw.walls };
}
