// Types shared by the virtual-staging orchestrator (Claude + in-process Node/Three.js geometry).
// Furniture comes live from IKEA's catalog through src/services/ikeaService.ts —
// there is no locally-hosted furniture catalog.
//
// Coordinate convention: Y-up, matching ARKit RoomPlan's native `scans.serialized`
// data AND how the frontend's ThreeJSRenderer already consumes it directly (no axis
// conversion happens there). position[1] is the vertical/floor-contact axis;
// rotation is yaw around that same Y axis. This used to be Z-up because Blender's
// USD importer silently remapped axes on the way in - now that nothing imports
// through Blender/USD, everything here is native RoomPlan/Three.js Y-up.

export interface RoomShellInfo {
  bounds_min: [number, number, number];
  bounds_max: [number, number, number];
  wall_object_names: string[];
  floor_object_names: string[];
  ceiling_object_names: string[];
}

export interface DetectedObject {
  object_name: string;
  guessed_category: string;
  position: [number, number, number];
  rotation_y_degrees: number;
  dimensions_cm: [number, number, number];
  /** RoomPlan's own identifier for this object (see scans.serialized). */
  roomplan_identifier?: string;
}

export interface SceneInspection {
  room: RoomShellInfo;
  objects: DetectedObject[];
}

export interface IkeaSearchResult {
  itemNo: string;
  name: string;
  mainImageUrl: string;
  mainImageAlt: string;
  pipUrl: string;
}

/** Raw IKEA product-info-page JSON, passed through as-is (name/price/styleGroup/typeName/images/... — schema is IKEA's, not ours). */
export type IkeaProduct = Record<string, unknown>;

export interface IkeaImportResult {
  dimensions_cm: [number, number, number];
  /** Other furniture (not walls/floor/ceiling) whose bounding box meaningfully overlaps this item at its final position. Informational — some overlap (e.g. a lamp on a table) is legitimate. */
  overlapping_object_names: string[];
  success: boolean;
  output: string;
}

export interface FloorMaterial {
  material_id: string;
  name: string;
  source: string;
  diffuse_path: string;
  normal_path: string;
  roughness_path: string;
  tile_size_cm: [number, number];
}

export interface WallMaterial {
  material_id: string;
  name: string;
  hex_color: string;
}

export interface MaterialCatalog {
  floors: FloorMaterial[];
  walls: WallMaterial[];
}

export type StagingAction =
  | { type: "place"; item_no: string; position: [number, number, number]; rotation_y_degrees: number }
  | {
      type: "replace";
      object_name: string;
      /** RoomPlan's own identifier for the object being replaced, when known — see scans.serialized. */
      replaces_roomplan_identifier?: string;
      item_no: string;
      position?: [number, number, number];
      rotation_y_degrees?: number;
    }
  | { type: "wall_color"; wall_object_names: string[] | "all"; material_id: string; hex_color: string }
  | {
      type: "floor_material";
      material_id: string;
      // Self-embedded (mirroring wall_color's hex_color) so a persisted StagingSummary
      // is enough on its own to re-render the scene client-side, with no second fetch
      // back to the materials catalog.
      diffuse_path: string;
      normal_path: string;
      roughness_path: string;
      tile_size_cm: [number, number];
    };

export interface StagingSummary {
  actions: StagingAction[];
  notes: string;
  preview_render_path: string | null;
  errors: string[];
}

export type StagingStatus = "none" | "pending" | "processing" | "done" | "error";

// --- Raw ARKit RoomPlan JSON (scans.serialized) — the actual shape of each entity
// across walls/floors/objects/doors/windows/openings, confirmed directly against a
// real scan row. `transform` is a 16-float column-major 4x4 matrix (translation at
// indices 12/13/14 = x/y/z); `category` is a single-key record whose key IS the
// category name (e.g. `{ "chair": {} }`).

export interface RoomPlanEntity {
  identifier: string;
  category: Record<string, unknown>;
  transform: number[];
  dimensions: number[];
  parentIdentifier?: string | null;
  [key: string]: unknown;
}

export interface RoomPlanCapturedRoom {
  walls: RoomPlanEntity[];
  floors: RoomPlanEntity[];
  objects: RoomPlanEntity[];
  doors: RoomPlanEntity[];
  windows: RoomPlanEntity[];
  openings: RoomPlanEntity[];
  [key: string]: unknown;
}
