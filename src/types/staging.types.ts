// Types shared by the virtual-staging orchestrator (Claude + headless Blender on the VM).
// Furniture comes live from IKEA's catalog through the Blender bridge (blender-bridge/ikea_lib.py) —
// there is no locally-hosted furniture catalog.

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
  rotation_z_degrees: number;
  dimensions_cm: [number, number, number];
  /** RoomPlan's own identifier for this object (see scans.serialized), when it could be resolved. */
  roomplan_identifier?: string;
}

export interface SceneInspection {
  session_id: string;
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
  object_names: string[];
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
  | { type: "place"; item_no: string; position: [number, number, number]; rotation_z_degrees: number }
  | {
      type: "replace";
      object_name: string;
      /** RoomPlan's own identifier for the object being replaced, when known — see scans.serialized. */
      replaces_roomplan_identifier?: string;
      item_no: string;
      position?: [number, number, number];
      rotation_z_degrees?: number;
    }
  | { type: "wall_color"; wall_object_names: string[] | "all"; material_id: string; hex_color: string }
  | { type: "floor_material"; material_id: string };

export interface StagingSummary {
  actions: StagingAction[];
  notes: string;
  preview_render_path: string | null;
  errors: string[];
}

export type StagingStatus = "none" | "pending" | "processing" | "done" | "error";

// --- Raw ARKit RoomPlan JSON (scans.serialized) — just enough shape to correlate
// Blender's synthetic "<Category><Index>" object names back to RoomPlan's own
// per-object identifier. See stagingOrchestratorService.buildRoomPlanIdentifierMap.

export interface RoomPlanEntity {
  identifier: string;
  category: Record<string, unknown>;
}

export interface RoomPlanCapturedRoom {
  walls: RoomPlanEntity[];
  floors: RoomPlanEntity[];
  objects: RoomPlanEntity[];
  [key: string]: unknown;
}
