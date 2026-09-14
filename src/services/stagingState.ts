/**
 * Internal orchestration state - not Claude-facing (staging.types.ts) and not
 * frontend-shared (espace-client's stagingTypes.ts). Split out from
 * stagingOrchestratorService.ts so stagingToolHandlers.ts can share these types
 * without an import cycle back into the orchestrator.
 */

import { LocalBoundingBox } from "./glbGeometryService";
import { RoomGeometry } from "./roomShellService";
import { StagingRenderSession } from "./stagingRenderService";
import { FlattenedSlot } from "../staging/roomManifests";
import { DetectedObject, MaterialCatalog, PlacementIntent, RoomPlanCapturedRoom, StagingAction } from "../types/staging.types";

export interface PlacedItem {
  itemNo: string;
  /** "local" for a non-IKEA model (see localModelService.ts) - fixed-equipment
   * seeds don't have a real GLB at all so this is meaningless for them, but
   * every "placed" slot needs it to know which service's getModel() to call
   * again (e.g. on adjust_placement). Defaults to "ikea" when absent for any
   * pre-existing slot construction that predates this field. */
  modelSource: "ikea" | "local";
  /** The model's own as-authored bounding box, before placement - reconstructed
   * from dimensions_cm (centered, symmetric) for fixed-equipment objects, which
   * have no real GLB. */
  localBox: LocalBoundingBox;
  position: [number, number, number];
  rotationYDegrees: number;
  /** "fixed_equipment" seeds (bathtub/toilet/oven/... - see
   * furnitureStrippingService.ts) can never be targeted by adjust_placement,
   * since nothing ever replaces them - only "placed" slots (manifest items
   * Claude has placed) can be re-solved. */
  sourceKind: "fixed_equipment" | "placed";
  /** The intent that produced this position - kept for audit and so
   * adjust_placement's error messages can reference "what you last asked for." */
  intent?: PlacementIntent;
  /** Set only when the manifest slot has forced_relative_to - the slot_id
   * this item is intentionally allowed to overlap beyond the normal
   * hard-constraint threshold (see layoutValidationService.ts). */
  allowedOverlapTargetId?: string;
}

export interface RunState {
  /** True only if the MOST RECENT review_layout found zero hard-constraint
   * violations across the whole room - finish_staging's real gate. */
  lastReviewClean: boolean;
  /** Every render_preview + review_layout call counts against one shared
   * budget (see MAX_RENDER_CALLS in stagingToolHandlers.ts) - each is a real
   * headless-browser screenshot (~30-45s, plus image tokens), and nothing
   * requires checking in after every single placement. */
  renderCallCount: number;
  /** How many place_manifest_item/adjust_placement attempts a given slot_id has
   * used - a slot is "given up on" once this hits MAX_SLOT_ATTEMPTS (see
   * stagingOrchestratorService.ts), letting the phase-completion check move on
   * instead of the run stalling on one stubborn slot. */
  slotAttempts: Map<string, number>;
  /**
   * What CURRENTLY occupies each slot, keyed by fixed-equipment object_name or
   * by the manifest's slot_id. Seeded at startup with one entry per kept
   * (fixed-equipment) RoomPlan object, so hard-constraint checks always scan one
   * uniform collection. Placing/adjusting a slot is just overwriting its map
   * entry.
   */
  slots: Map<string, PlacedItem>;
}

export interface StagingContext {
  serialized: RoomPlanCapturedRoom;
  objectsByName: Map<string, DetectedObject>;
  materials: MaterialCatalog;
  /** This run's assigned manifest, flattened and keyed by (zone-prefixed)
   * slot_id - lets place_manifest_item map slot_id -> item_no server-side,
   * never a value Claude supplies directly. */
  manifestSlots: Map<string, FlattenedSlot>;
  /** Room's floor height (bounds_min[1]) - where a resolved item's Y lands. */
  floorY: number;
  /** Structured room geometry (walls/doors/windows/floor polygon/collision boxes)
   * for the solver, validator, and scorer - computed once at startup. */
  geometry: RoomGeometry;
  renderSession: StagingRenderSession;
  actions: StagingAction[];
  errors: string[];
  state: RunState;
  /** RoomPlan identifiers of objects stripped before Claude ever saw the scan -
   * threaded into every render call so screenshots (in-loop and final) match
   * what the real client renderer will show (see StagedSceneRenderer.tsx's
   * strippedRoomplanIdentifiers prop). */
  strippedRoomplanIdentifiers: string[];
}
