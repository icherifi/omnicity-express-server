/**
 * One function per tool, extracted out of what used to be a single growing
 * switch statement in stagingOrchestratorService.ts. Each handler owns its own
 * input validation and StagingContext mutation; stagingOrchestratorService.ts's
 * callTool() is now a thin dispatcher.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as ikeaService from "./ikeaService";
import * as localModelService from "./localModelService";
import * as glbGeometryService from "./glbGeometryService";
import { LocalBoundingBox } from "./glbGeometryService";
import { EntityLookup, resolveIntent, SolverResult } from "./placementSolverService";
import { Footprint, OtherFootprint, validateAllPlacements, validateAndMaybeCorrect } from "./layoutValidationService";
import { PlacedItem, RunState, StagingContext } from "./stagingState";
import { FlattenedSlot } from "../staging/roomManifests";
import { HardConstraintViolation, PlacementIntent } from "../types/staging.types";

export type ToolResultContent = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>;

function footprintOf(item: PlacedItem): Footprint {
  const [widthM, heightM, depthM] = glbGeometryService.dimensionsCm(item.localBox).map((cm) => cm / 100) as [number, number, number];
  return {
    localBox: item.localBox,
    position: item.position,
    rotationYDegrees: item.rotationYDegrees,
    widthM,
    heightM,
    depthM,
    allowedOverlapTargetId: item.allowedOverlapTargetId,
  };
}

function otherFootprints(state: RunState, excludeKey: string | null): OtherFootprint[] {
  const result: OtherFootprint[] = [];
  for (const [key, item] of state.slots) {
    if (key === excludeKey) continue;
    result.push({
      key,
      localBox: item.localBox,
      position: item.position,
      rotationYDegrees: item.rotationYDegrees,
      allowedOverlapTargetId: item.allowedOverlapTargetId,
    });
  }
  return result;
}

function toResolvedEntity(key: string, item: PlacedItem) {
  return {
    key,
    position: item.position,
    rotationYDegrees: item.rotationYDegrees,
    widthM: item.localBox.max[0] - item.localBox.min[0],
    heightM: item.localBox.max[1] - item.localBox.min[1],
    depthM: item.localBox.max[2] - item.localBox.min[2],
  };
}

function entityLookupFor(state: RunState): EntityLookup {
  return {
    resolveFurniture(id) {
      const item = state.slots.get(id);
      return item ? toResolvedEntity(id, item) : null;
    },
    listAllPlaced() {
      return [...state.slots.entries()].map(([key, item]) => toResolvedEntity(key, item));
    },
  };
}

function violationsText(violations: HardConstraintViolation[]): string {
  return violations.map((v) => `${v.constraint} (${v.detail})`).join("; ");
}

/** Shared budget for render_preview + review_layout combined - each is a real
 * headless-browser screenshot, expensive in both time and tokens, and Claude
 * doesn't need to look after every single placement. The last slot is
 * reserved for review_layout specifically, so a run that spends its earlier
 * slots on ad hoc render_preview checks always still has one guaranteed shot
 * at the mandatory final gate check. */
const MAX_RENDER_CALLS = 5;

function checkRenderBudget(ctx: StagingContext, toolName: "render_preview" | "review_layout"): string | null {
  if (ctx.state.renderCallCount >= MAX_RENDER_CALLS) {
    return `ERROR: render/review budget exhausted (${MAX_RENDER_CALLS} used this run, shared between render_preview and review_layout) - no more renders available. Finish with what you have.`;
  }
  if (toolName === "render_preview" && ctx.state.renderCallCount === MAX_RENDER_CALLS - 1) {
    return `ERROR: only 1 render left in the shared budget, and it's reserved for review_layout (the mandatory final check) - call review_layout instead of render_preview.`;
  }
  return null;
}

/** A manifest slot is "given up on" after this many failed place_manifest_item/
 * adjust_placement attempts - formalizes what used to be prompt-text-only
 * guidance ("abandon after 2-3 attempts") into a real, enforced cap. Exported
 * so the orchestrator's phase-completion check (a slot counts as "done" once
 * it's placed OR hit this cap) uses the exact same number this file enforces. */
export const MAX_SLOT_ATTEMPTS = 3;

function recordAttempt(ctx: StagingContext, slotId: string): void {
  ctx.state.slotAttempts.set(slotId, (ctx.state.slotAttempts.get(slotId) ?? 0) + 1);
}

interface ResolvedPlacement {
  localBox: LocalBoundingBox;
  dimensions_cm: [number, number, number];
  position: [number, number, number];
  rotationYDegrees: number;
  corrected: boolean;
  correctionReason?: string;
  solverWarning?: string;
}

/** The shared core of place_manifest_item/adjust_placement: fetch the model,
 * ask the solver to turn the intent into geometry, then gate that geometry
 * through the full hard-constraint battery (with its one-shot corrective-nudge
 * policy). Returns an ERROR string on either failure - neither path mutates
 * state, callers only commit a slot on success. */
async function resolveAndValidate(
  itemNo: string,
  modelSource: "ikea" | "local",
  intent: PlacementIntent,
  ctx: StagingContext,
  excludeKey: string | null,
  allowedOverlapTargetId?: string
): Promise<ResolvedPlacement | { error: string }> {
  const glbPath = modelSource === "local" ? await localModelService.getModel(itemNo) : await ikeaService.getModel(itemNo);
  const localBox = glbGeometryService.computeLocalBoundingBox(glbPath);
  const dimensions_cm = glbGeometryService.dimensionsCm(localBox);
  const [widthM, heightM, depthM] = dimensions_cm.map((cm) => cm / 100) as [number, number, number];

  const solved: SolverResult = resolveIntent(intent, { widthM, heightM, depthM }, ctx.floorY, ctx.geometry, entityLookupFor(ctx.state));
  if (!solved.ok) return { error: `${solved.error}: ${solved.message}` };

  const footprint: Footprint = {
    localBox,
    position: solved.position,
    rotationYDegrees: solved.rotationYDegrees,
    widthM,
    heightM,
    depthM,
    allowedOverlapTargetId,
  };
  const validation = validateAndMaybeCorrect(footprint, otherFootprints(ctx.state, excludeKey), ctx.geometry);
  if (!validation.ok) {
    return { error: `Placement rejected - ${violationsText(validation.violations)}. Try a different anchor, a smaller item, or add a nudge_cm.` };
  }

  return {
    localBox,
    dimensions_cm,
    position: validation.position,
    rotationYDegrees: validation.rotation_y_degrees,
    corrected: validation.corrected,
    correctionReason: validation.correction_reason,
    solverWarning: solved.warning,
  };
}

function placementNotes(resolved: ResolvedPlacement): string | undefined {
  const parts: string[] = [];
  if (resolved.corrected) parts.push(`auto-corrected (${resolved.correctionReason}) to satisfy hard constraints`);
  if (resolved.solverWarning) parts.push(resolved.solverWarning);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/** forced_facing removes facing from Claude's decision for slots where the
 * correct orientation is knowable in advance - overrides whatever Claude
 * supplied, or fills it in if omitted.
 * - "toward_depends_on_target": face the slot's own dependency (e.g. a chair
 *   facing its table - left_of/right_of would otherwise default to
 *   "match_target", facing the same way the table faces).
 * - "anchor_default": strip facing entirely so the anchor's own deterministic
 *   default wins (e.g. zone_center's nearestWallRotation), so Claude can't
 *   override it with an explicit facing.
 * Exported separately so this rule is unit-testable without a StagingContext. */
export function applyForcedFacing(slot: FlattenedSlot, intent: PlacementIntent): PlacementIntent {
  if (slot.forced_facing === "toward_depends_on_target" && slot.depends_on_slot_id) {
    return { ...intent, facing: { kind: "toward_object", target_id: slot.depends_on_slot_id } };
  }
  if (slot.forced_facing === "anchor_default") {
    return { anchor: intent.anchor, nudge_cm: intent.nudge_cm };
  }
  return intent;
}

/** forced_align removes a relative_to intent's lateral alignment from
 * Claude's decision - relative_to's own default is EDGE-aligned when `align`
 * is omitted, not centered, so a coffee table in_front_of a sofa would sit
 * flush with one arm instead of centered unless this forces "center". */
export function applyForcedAlign(slot: FlattenedSlot, intent: PlacementIntent): PlacementIntent {
  if (slot.forced_align && intent.anchor.kind === "relative_to") {
    return { ...intent, anchor: { ...intent.anchor, align: slot.forced_align } };
  }
  return intent;
}

/** forced_relative_to fully replaces a relative_to anchor's relation/align/
 * gap_cm/target_id - Claude's own anchor is discarded wholesale (superset of
 * applyForcedAlign), for a slot where the entire relative placement is
 * knowable in advance (e.g. a dining chair always on the same table edge,
 * centered, tucked under it - see DINING_CHAIR_TUCK_GAP_CM). */
export function applyForcedRelativeTo(slot: FlattenedSlot, intent: PlacementIntent): PlacementIntent {
  if (slot.forced_relative_to && slot.depends_on_slot_id) {
    const { relation, align, gap_cm } = slot.forced_relative_to;
    return { ...intent, anchor: { kind: "relative_to", target_id: slot.depends_on_slot_id, relation, align, gap_cm } };
  }
  return intent;
}

/** Places one manifest slot (see roomManifests.ts) - Claude picks slot_id from
 * an enum the orchestrator narrows to the current phase's legal slots (never a
 * free string), and item_no is looked up server-side, never chosen by Claude.
 * The manifest's allowed_anchor_kinds is enforced here (the Anthropic tool
 * schema can't vary per slot_id value). */
export async function handlePlaceManifestItem(input: any, ctx: StagingContext): Promise<ToolResultContent> {
  const slotId: string = input.slot_id;
  const slot = ctx.manifestSlots.get(slotId);
  if (!slot) return `ERROR: unknown slot_id '${slotId}'.`;
  if (ctx.state.slots.has(slotId)) {
    return `ERROR: '${slotId}' is already placed - use adjust_placement to change its position, not place_manifest_item again.`;
  }
  if ((ctx.state.slotAttempts.get(slotId) ?? 0) >= MAX_SLOT_ATTEMPTS) {
    return `ERROR: '${slotId}' has been abandoned after ${MAX_SLOT_ATTEMPTS} failed attempts - move on to other slots.`;
  }

  // Counts even a malformed intent as a real attempt (recorded before the
  // anchor-kind check) - otherwise a persistently malformed call could retry
  // the same slot indefinitely without ever tripping the abandonment cap.
  recordAttempt(ctx, slotId);

  const anchorKind = input.intent?.anchor?.kind;
  if (!slot.allowed_anchor_kinds.includes(anchorKind)) {
    return `ERROR: slot '${slotId}' only accepts anchor kind(s) [${slot.allowed_anchor_kinds.join(", ")}], got '${anchorKind}'. intent must be shaped {anchor: {kind: ..., ...}}, not the anchor fields directly on intent.`;
  }

  const intent: PlacementIntent = applyForcedRelativeTo(slot, applyForcedAlign(slot, applyForcedFacing(slot, input.intent)));
  const allowedOverlapTargetId = slot.forced_relative_to ? slot.depends_on_slot_id : undefined;

  const resolved = await resolveAndValidate(slot.item_no, slot.model_source ?? "ikea", intent, ctx, null, allowedOverlapTargetId);
  if ("error" in resolved) return `ERROR: ${resolved.error}`;

  ctx.state.slots.set(slotId, {
    itemNo: slot.item_no,
    modelSource: slot.model_source ?? "ikea",
    localBox: resolved.localBox,
    position: resolved.position,
    rotationYDegrees: resolved.rotationYDegrees,
    sourceKind: "placed",
    intent,
    allowedOverlapTargetId,
  });
  ctx.actions.push({
    type: "place",
    slot_id: slotId,
    item_no: slot.item_no,
    model_source: slot.model_source ?? "ikea",
    position: resolved.position,
    rotation_y_degrees: resolved.rotationYDegrees,
    intent,
  });

  return JSON.stringify({ dimensions_cm: resolved.dimensions_cm, notes: placementNotes(resolved) });
}

export async function handleAdjustPlacement(input: any, ctx: StagingContext): Promise<ToolResultContent> {
  const slotId: string = input.slot_id;
  const existing = ctx.state.slots.get(slotId);
  if (!existing) return `ERROR: no item named '${slotId}' exists - use place_manifest_item first.`;
  if (existing.sourceKind === "fixed_equipment") {
    return `ERROR: '${slotId}' is fixed equipment and cannot be moved.`;
  }

  recordAttempt(ctx, slotId);

  // Same forced_facing/forced_align/forced_relative_to overrides as
  // place_manifest_item - without them, adjusting a slot here would bypass
  // every determinism guarantee place_manifest_item enforces. slot is always
  // found in practice; the fallback is defensive only.
  const slot = ctx.manifestSlots.get(slotId);
  const intent: PlacementIntent = slot
    ? applyForcedRelativeTo(slot, applyForcedAlign(slot, applyForcedFacing(slot, input.intent)))
    : input.intent;
  const allowedOverlapTargetId = slot?.forced_relative_to ? slot.depends_on_slot_id : undefined;

  const resolved = await resolveAndValidate(existing.itemNo, existing.modelSource, intent, ctx, slotId, allowedOverlapTargetId);
  if ("error" in resolved) return `ERROR: ${resolved.error}`;

  ctx.state.slots.set(slotId, {
    ...existing,
    position: resolved.position,
    rotationYDegrees: resolved.rotationYDegrees,
    intent,
    allowedOverlapTargetId,
  });

  // Update the matching action in place (same item, new position) rather than
  // appending a duplicate - the persisted staging_summary should reflect where
  // things actually ended up, not every intermediate adjustment.
  const targetIndex = ctx.actions.findIndex((a) => a.type === "place" && a.slot_id === slotId);
  if (targetIndex !== -1) {
    const action = ctx.actions[targetIndex];
    if (action.type === "place") {
      ctx.actions[targetIndex] = { ...action, position: resolved.position, rotation_y_degrees: resolved.rotationYDegrees, intent };
    }
  }

  return JSON.stringify({ dimensions_cm: glbGeometryService.dimensionsCm(resolved.localBox), notes: placementNotes(resolved) });
}

/** Lightweight, ad hoc "just show me a picture" check - a single top-down
 * plan view, no scoring. That one view is enough to judge spacing/overlaps/
 * traffic flow, which is what this ad hoc check is for - review_layout is the
 * heavier, gating tool for a real finishing pass. */
export async function handleRenderPreview(ctx: StagingContext): Promise<ToolResultContent> {
  const budgetError = checkRenderBudget(ctx, "render_preview");
  if (budgetError) return budgetError;
  ctx.state.renderCallCount++;

  const [view] = await ctx.renderSession.renderPreview({
    scanData: ctx.serialized,
    actions: ctx.actions,
    views: ["top-down"],
    strippedRoomplanIdentifiers: ctx.strippedRoomplanIdentifiers,
  });
  return [
    { type: "text", text: "Top-down plan view:" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: view.buffer.toString("base64") } },
  ];
}

/** The heavier, gating finishing-pass tool: re-validates every current
 * placement against the FULL hard-constraint battery (a defensive re-check,
 * since adjust_placement never cascades a re-solve to items placed relative to
 * whatever it moved), and renders the top-down plan view - everything Claude
 * needs for a single "is this room actually done" judgment in one tool call. */
export async function handleReviewLayout(ctx: StagingContext): Promise<ToolResultContent> {
  const budgetError = checkRenderBudget(ctx, "review_layout");
  if (budgetError) return budgetError;
  ctx.state.renderCallCount++;

  const footprintItems = [...ctx.state.slots.entries()].map(([key, item]) => ({
    key,
    isFixed: item.sourceKind === "fixed_equipment",
    ...footprintOf(item),
  }));
  const violationsByItem = validateAllPlacements(footprintItems, ctx.geometry);
  ctx.state.lastReviewClean = violationsByItem.length === 0;

  const reportLines: string[] = [];
  if (violationsByItem.length === 0) {
    reportLines.push("Hard constraints: no violations.");
  } else {
    reportLines.push("Hard constraints - violations found:");
    for (const { key, violations } of violationsByItem) {
      reportLines.push(`- ${key}: ${violationsText(violations)}`);
    }
    reportLines.push("finish_staging will be rejected until these are fixed (adjust_placement the affected slots).");
  }

  const [view] = await ctx.renderSession.renderPreview({
    scanData: ctx.serialized,
    actions: ctx.actions,
    views: ["top-down"],
    strippedRoomplanIdentifiers: ctx.strippedRoomplanIdentifiers,
  });
  return [
    { type: "text", text: reportLines.join("\n") },
    { type: "text", text: "Top-down plan view — check spacing, overlaps, clearances, traffic flow:" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: view.buffer.toString("base64") } },
  ];
}

export function handleFinishStaging(ctx: StagingContext): ToolResultContent {
  if (!ctx.state.lastReviewClean) {
    return "ERROR: call review_layout (with zero remaining hard-constraint violations) before finishing.";
  }
  return "Staging finished.";
}
