/**
 * Internal orchestration state - not Claude-facing (staging.types.ts) and not
 * frontend-shared (espace-client's stagingTypes.ts). Split out from
 * stagingOrchestratorService.ts so stagingToolHandlers.ts can share these types
 * without an import cycle back into the orchestrator.
 */

import { LocalBoundingBox } from "./glbGeometryService";
import { RoomGeometry } from "./roomShellService";
import { StagingRenderSession } from "./stagingRenderService";
import { DetectedObject, MaterialCatalog, PlacementIntent, RoomPlanCapturedRoom, StagingAction } from "../types/staging.types";

export interface PlacedItem {
  itemNo: string;
  /** The model's own as-authored bounding box, before placement - reconstructed
   * from dimensions_cm (centered, symmetric) for original scanned objects, which
   * have no real GLB. */
  localBox: LocalBoundingBox;
  position: [number, number, number];
  rotationYDegrees: number;
  /** "original_scan" seeds can't be targeted by adjust_placement (use
   * replace_furniture first) - only "placed"/"replaced" slots can be re-solved. */
  sourceKind: "original_scan" | "placed" | "replaced";
  /** The intent that produced this position, when placed via intent-based
   * place_furniture/replace_furniture/adjust_placement - kept for audit and so
   * adjust_placement's error messages can reference "what you last asked for." */
  intent?: PlacementIntent;
}

export interface RunState {
  hasSetWallColor: boolean;
  hasSetFloorMaterial: boolean;
  /** True only if the MOST RECENT review_layout found zero hard-constraint
   * violations across the whole room - finish_staging's real gate (replacing
   * "render_preview was called at least once"). render_preview alone no longer
   * satisfies it. */
  lastReviewClean: boolean;
  /**
   * What CURRENTLY occupies each slot, keyed by the original scanned object's
   * object_name for replace_furniture targets, or Claude's own instance_name for
   * place_furniture. Seeded at startup with one entry per original RoomPlan
   * furniture object, so hard-constraint checks always scan one uniform
   * collection. Replacing/adjusting a slot is just overwriting its map entry.
   */
  slots: Map<string, PlacedItem>;
}

export interface StagingContext {
  serialized: RoomPlanCapturedRoom;
  objectsByName: Map<string, DetectedObject>;
  materials: MaterialCatalog;
  /** Room's floor height (bounds_min[1]) - where a resolved item's Y lands. */
  floorY: number;
  /** Structured room geometry (walls/doors/windows/floor polygon/collision boxes)
   * for the solver, validator, and scorer - computed once at startup. */
  geometry: RoomGeometry;
  renderSession: StagingRenderSession;
  actions: StagingAction[];
  errors: string[];
  state: RunState;
}
