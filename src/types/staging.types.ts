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
  /** One polygon (loop of [worldX, worldZ] points) per floors[] entity - RoomPlan's
   * own real walkable-floor contour, not a derived/approximated one. */
  floor_polygons: [number, number][][];
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

export interface RoomSection {
  label: string;
  center: [number, number, number];
}

export interface SceneInspection {
  room: RoomShellInfo;
  objects: DetectedObject[];
  /** Structured (not just bounding-box-contributing) wall/door/window data, in the
   * same DetectedObject shape as furniture - lets Claude reason textually about
   * them (e.g. "don't block this door") instead of only seeing them as pixels in
   * render_preview. guessed_category is always "wall"/"door"/"window" here. */
  walls: DetectedObject[];
  doors: DetectedObject[];
  windows: DetectedObject[];
  /** RoomPlan's own room-zone labels ("bedroom", "kitchen", "bathroom", ...),
   * passed through as-is - not used for hard/soft constraints today, but cheap
   * context for Claude's own judgement. */
  sections: RoomSection[];
}

// --- Placement intent vocabulary (Phase 3) ---------------------------------
// Claude expresses WHERE/WHICH-WAY relationally instead of picking raw
// coordinates; placementSolverService.ts turns one of these into an exact
// (position, rotation) using the room's real geometry. snake_case throughout to
// match the tool input_schema wire format directly (no remapping layer).

export type WallAlignment = "center" | { from_corner: "start" | "end"; offset_cm: number };

export type PlacementAnchor =
  | { kind: "against_wall"; wall_id: string; along?: WallAlignment; gap_cm?: number }
  | { kind: "in_corner"; wall_id_a: string; wall_id_b: string; gap_cm?: number }
  | { kind: "room_center" }
  | {
      kind: "relative_to";
      target_id: string;
      relation: "left_of" | "right_of" | "in_front_of" | "behind";
      gap_cm?: number;
      align?: "center" | "start" | "end";
    };

export type FacingIntent =
  | { kind: "away_from_wall" }
  | { kind: "match_target" }
  | { kind: "toward_target" }
  | { kind: "toward_room_center" }
  | { kind: "toward_object"; target_id: string }
  | { kind: "toward_wall"; wall_id: string }
  | { kind: "toward_window"; window_id: string }
  | { kind: "explicit_degrees"; degrees: number };

export interface PlacementIntent {
  anchor: PlacementAnchor;
  /** Omitted = defaulted from the anchor/relation (see placementSolverService.ts). */
  facing?: FacingIntent;
  /** Bounded fine-tune (±40cm each axis) applied AFTER the anchor/facing solve, in
   * the item's OWN solved local frame (forward/lateral) - NOT world coordinates.
   * Still fully re-validated against every hard constraint; never bypasses them. */
  nudge_cm?: { forward?: number; lateral?: number };
}

export interface HardConstraintViolation {
  constraint: "wall_penetration" | "furniture_overlap" | "door_clearance" | "window_blocked" | "floor_polygon" | "ceiling_height";
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  corrected: boolean;
  correction_reason?: string;
  position: [number, number, number];
  rotation_y_degrees: number;
  violations: HardConstraintViolation[];
}

export interface SoftScores {
  circulation: number;
  fill: number;
  blocked_fraction: number;
  focal_point: number | null;
  scale: number;
  overall: number;
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
  | {
      type: "place";
      /** Claude's own handle for this item, unique across the run - lets a later
       * adjust_placement/relative_to intent reference it, and lets adjust_placement
       * find+update this exact action in place instead of appending a duplicate. */
      instance_name: string;
      item_no: string;
      position: [number, number, number];
      rotation_y_degrees: number;
      /** The intention that resolved to this position/rotation, if placed via the
       * intent-based tools - kept for audit/debugging (why did Claude put this
       * here), never read back by the renderer. */
      intent?: PlacementIntent;
    }
  | {
      type: "replace";
      object_name: string;
      /** RoomPlan's own identifier for the object being replaced, when known — see scans.serialized. */
      replaces_roomplan_identifier?: string;
      item_no: string;
      position?: [number, number, number];
      rotation_y_degrees?: number;
      intent?: PlacementIntent;
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
  /** Apple RoomPlan's own room-zone labels - not geometry, just {label, center}
   * per detected zone (e.g. "kitchen", "bedroom"). Optional: older scans predate it. */
  sections?: Array<{ label: string; story?: number; center: number[] }>;
  [key: string]: unknown;
}
