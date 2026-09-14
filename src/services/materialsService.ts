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
import { FloorMaterial, MaterialCatalog, StagingAction, WallMaterial } from "../types/staging.types";

// Neutral, safe defaults from the curated catalog - avoids the 2 explicit
// "accent" wall colors and the higher-contrast floor/wall options that read
// more like a styled choice than a safe default. No per-archetype variation:
// a wall sits at the boundary between two zones (roomZoningService.ts has no
// notion of "which wall belongs to which zone" - that would need a whole new
// wall-ownership algorithm for a purely cosmetic feature), so one global pair
// for the whole run is the right amount of complexity here.
const DEFAULT_WALL_MATERIAL_ID = "soft_greige";
const DEFAULT_FLOOR_MATERIAL_ID = "oak_light";

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

/** Wall color + floor material are no longer a Claude decision - applied
 * programmatically once, at the start of the run, so even the in-loop
 * screenshots already show the correct treatment. Throws if the catalog
 * doesn't contain the hardcoded defaults (a manifest.json edit removing them
 * should fail loudly at startup, not silently skip materials for every run). */
export function buildDefaultMaterialActions(materials: MaterialCatalog): StagingAction[] {
  const wall = materials.walls.find((w) => w.material_id === DEFAULT_WALL_MATERIAL_ID);
  const floor = materials.floors.find((f) => f.material_id === DEFAULT_FLOOR_MATERIAL_ID);
  if (!wall) throw new Error(`Default wall material_id '${DEFAULT_WALL_MATERIAL_ID}' not found in the materials catalog.`);
  if (!floor) throw new Error(`Default floor material_id '${DEFAULT_FLOOR_MATERIAL_ID}' not found in the materials catalog.`);

  return [
    { type: "wall_color", wall_object_names: "all", material_id: wall.material_id, hex_color: wall.hex_color },
    {
      type: "floor_material",
      material_id: floor.material_id,
      diffuse_path: floor.diffuse_path,
      normal_path: floor.normal_path,
      roughness_path: floor.roughness_path,
      tile_size_cm: floor.tile_size_cm,
    },
  ];
}
