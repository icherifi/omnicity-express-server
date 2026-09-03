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
  success: boolean;
  output: string;
}

export type StagingAction =
  | { type: "place"; item_no: string; position: [number, number, number]; rotation_z_degrees: number }
  | {
      type: "replace";
      object_name: string;
      item_no: string;
      position?: [number, number, number];
      rotation_z_degrees?: number;
    }
  | { type: "wall_color"; wall_object_names: string[] | "all"; hex_color: string }
  | { type: "floor_material"; hex_color: string; finish: "matte" | "satin" | "glossy" };

export interface StagingSummary {
  actions: StagingAction[];
  notes: string;
  preview_render_path: string | null;
  errors: string[];
}

export type StagingStatus = "none" | "pending" | "processing" | "done" | "error";
