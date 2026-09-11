/**
 * One function per tool, extracted out of what used to be a single growing
 * switch statement in stagingOrchestratorService.ts. Each handler owns its own
 * input validation and StagingContext mutation; stagingOrchestratorService.ts's
 * callTool() is now a thin dispatcher.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as ikeaService from "./ikeaService";
import * as glbGeometryService from "./glbGeometryService";
import { LocalBoundingBox } from "./glbGeometryService";
import { EntityLookup, resolveIntent, SolverResult } from "./placementSolverService";
import { Footprint, OtherFootprint, validateAllPlacements, validateAndMaybeCorrect } from "./layoutValidationService";
import { ScoredItem, scoreLayout } from "./layoutQualityService";
import { PlacedItem, RunState, StagingContext } from "./stagingState";
import { HardConstraintViolation, MaterialCatalog, PlacementIntent } from "../types/staging.types";

export type ToolResultContent = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>;

function footprintOf(item: PlacedItem): Footprint {
  const [widthM, heightM, depthM] = glbGeometryService.dimensionsCm(item.localBox).map((cm) => cm / 100) as [number, number, number];
  return { localBox: item.localBox, position: item.position, rotationYDegrees: item.rotationYDegrees, widthM, heightM, depthM };
}

function otherFootprints(state: RunState, excludeKey: string | null): OtherFootprint[] {
  const result: OtherFootprint[] = [];
  for (const [key, item] of state.slots) {
    if (key === excludeKey) continue;
    result.push({ key, localBox: item.localBox, position: item.position, rotationYDegrees: item.rotationYDegrees });
  }
  return result;
}

function toResolvedEntity(item: PlacedItem) {
  return {
    position: item.position,
    rotationYDegrees: item.rotationYDegrees,
    widthM: item.localBox.max[0] - item.localBox.min[0],
    depthM: item.localBox.max[2] - item.localBox.min[2],
  };
}

function entityLookupFor(state: RunState): EntityLookup {
  return {
    resolveFurniture(id) {
      const item = state.slots.get(id);
      return item ? toResolvedEntity(item) : null;
    },
    listAllPlaced() {
      return [...state.slots.values()].map(toResolvedEntity);
    },
  };
}

function isNameTaken(name: string, ctx: StagingContext): boolean {
  return (
    ctx.state.slots.has(name) ||
    ctx.objectsByName.has(name) ||
    ctx.geometry.walls.some((w) => w.identifier === name) ||
    ctx.geometry.doors.some((d) => d.identifier === name) ||
    ctx.geometry.windows.some((w) => w.identifier === name)
  );
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

interface ResolvedPlacement {
  localBox: LocalBoundingBox;
  dimensions_cm: [number, number, number];
  position: [number, number, number];
  rotationYDegrees: number;
  corrected: boolean;
  correctionReason?: string;
  solverWarning?: string;
}

/** The shared core of place_furniture/replace_furniture/adjust_placement: fetch
 * the model, ask the solver to turn the intent into geometry, then gate that
 * geometry through the full hard-constraint battery (with its one-shot
 * corrective-nudge policy). Returns an ERROR string on either failure - neither
 * path mutates state, callers only commit a slot on success. */
async function resolveAndValidate(
  itemNo: string,
  intent: PlacementIntent,
  ctx: StagingContext,
  excludeKey: string | null
): Promise<ResolvedPlacement | { error: string }> {
  const glbPath = await ikeaService.getModel(itemNo);
  const localBox = glbGeometryService.computeLocalBoundingBox(glbPath);
  const dimensions_cm = glbGeometryService.dimensionsCm(localBox);
  const [widthM, heightM, depthM] = dimensions_cm.map((cm) => cm / 100) as [number, number, number];

  const solved: SolverResult = resolveIntent(intent, { widthM, heightM, depthM }, ctx.floorY, ctx.geometry, entityLookupFor(ctx.state));
  if (!solved.ok) return { error: `${solved.error}: ${solved.message}` };

  const footprint: Footprint = { localBox, position: solved.position, rotationYDegrees: solved.rotationYDegrees, widthM, heightM, depthM };
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

export async function handleSearchIkea(input: any): Promise<ToolResultContent> {
  return JSON.stringify(await ikeaService.search(input.query));
}

export async function handleGetIkeaProduct(input: any): Promise<ToolResultContent> {
  return JSON.stringify(await ikeaService.getProduct(input.item_no));
}

export async function handlePlaceFurniture(input: any, ctx: StagingContext): Promise<ToolResultContent> {
  const instanceName: string = input.instance_name;
  if (isNameTaken(instanceName, ctx)) {
    return `ERROR: instance_name '${instanceName}' is already used by another item, wall, door, or window - pick a different name.`;
  }

  const resolved = await resolveAndValidate(input.item_no, input.intent, ctx, null);
  if ("error" in resolved) return `ERROR: ${resolved.error}`;

  ctx.state.slots.set(instanceName, {
    itemNo: input.item_no,
    localBox: resolved.localBox,
    position: resolved.position,
    rotationYDegrees: resolved.rotationYDegrees,
    sourceKind: "placed",
    intent: input.intent,
  });
  ctx.actions.push({
    type: "place",
    instance_name: instanceName,
    item_no: input.item_no,
    position: resolved.position,
    rotation_y_degrees: resolved.rotationYDegrees,
    intent: input.intent,
  });

  return JSON.stringify({ dimensions_cm: resolved.dimensions_cm, notes: placementNotes(resolved) });
}

export async function handleReplaceFurniture(input: any, ctx: StagingContext): Promise<ToolResultContent> {
  const original = ctx.objectsByName.get(input.object_name);
  if (!original) return `ERROR: unknown object_name ${input.object_name} (not in room inspection)`;

  // No intent given: inherit the original scanned object's exact position/
  // rotation (today's fallback), still gated through the same hard-constraint
  // battery - a differently-sized replacement can legitimately no longer fit
  // where the original scan object sat.
  const intent: PlacementIntent | undefined = input.intent;
  let resolved: ResolvedPlacement | { error: string };
  if (intent) {
    resolved = await resolveAndValidate(input.item_no, intent, ctx, input.object_name);
  } else {
    const glbPath = await ikeaService.getModel(input.item_no);
    const localBox = glbGeometryService.computeLocalBoundingBox(glbPath);
    const dimensions_cm = glbGeometryService.dimensionsCm(localBox);
    const [widthM, heightM, depthM] = dimensions_cm.map((cm) => cm / 100) as [number, number, number];
    const position: [number, number, number] = [original.position[0], ctx.floorY, original.position[2]];
    const footprint: Footprint = { localBox, position, rotationYDegrees: original.rotation_y_degrees, widthM, heightM, depthM };
    const validation = validateAndMaybeCorrect(footprint, otherFootprints(ctx.state, input.object_name), ctx.geometry);
    resolved = validation.ok
      ? {
          localBox,
          dimensions_cm,
          position: validation.position,
          rotationYDegrees: validation.rotation_y_degrees,
          corrected: validation.corrected,
          correctionReason: validation.correction_reason,
        }
      : { error: `Inheriting the original position doesn't fit this item - ${violationsText(validation.violations)}. Provide an explicit intent instead.` };
  }
  if ("error" in resolved) return `ERROR: ${resolved.error}`;

  ctx.state.slots.set(input.object_name, {
    itemNo: input.item_no,
    localBox: resolved.localBox,
    position: resolved.position,
    rotationYDegrees: resolved.rotationYDegrees,
    sourceKind: "replaced",
    intent,
  });
  ctx.actions.push({
    type: "replace",
    object_name: input.object_name,
    replaces_roomplan_identifier: original.roomplan_identifier,
    item_no: input.item_no,
    position: resolved.position,
    rotation_y_degrees: resolved.rotationYDegrees,
    intent,
  });

  return JSON.stringify({ dimensions_cm: resolved.dimensions_cm, notes: placementNotes(resolved) });
}

export async function handleAdjustPlacement(input: any, ctx: StagingContext): Promise<ToolResultContent> {
  const instanceName: string = input.instance_name;
  const existing = ctx.state.slots.get(instanceName);
  if (!existing) return `ERROR: no item named '${instanceName}' exists - place_furniture or replace_furniture it first.`;
  if (existing.sourceKind === "original_scan") {
    return `ERROR: '${instanceName}' is still the original scanned object - use replace_furniture to swap it in first, then adjust_placement.`;
  }

  const resolved = await resolveAndValidate(existing.itemNo, input.intent, ctx, instanceName);
  if ("error" in resolved) return `ERROR: ${resolved.error}`;

  ctx.state.slots.set(instanceName, {
    ...existing,
    position: resolved.position,
    rotationYDegrees: resolved.rotationYDegrees,
    intent: input.intent,
  });

  // Update the matching action in place (same item, new position) rather than
  // appending a duplicate - the persisted staging_summary should reflect where
  // things actually ended up, not every intermediate adjustment. A "placed" slot
  // is keyed by instance_name on its own action; a "replaced" slot is keyed by
  // object_name (== instanceName, since that's how it was looked up above).
  const targetIndex = ctx.actions.findIndex(
    (a) => (a.type === "place" && a.instance_name === instanceName) || (a.type === "replace" && a.object_name === instanceName)
  );
  if (targetIndex !== -1) {
    const action = ctx.actions[targetIndex];
    if (action.type === "place") {
      ctx.actions[targetIndex] = { ...action, position: resolved.position, rotation_y_degrees: resolved.rotationYDegrees, intent: input.intent };
    } else if (action.type === "replace") {
      ctx.actions[targetIndex] = { ...action, position: resolved.position, rotation_y_degrees: resolved.rotationYDegrees, intent: input.intent };
    }
  }

  return JSON.stringify({ dimensions_cm: glbGeometryService.dimensionsCm(resolved.localBox), notes: placementNotes(resolved) });
}

export function handleSetWallColor(input: any, ctx: StagingContext): ToolResultContent {
  const material = ctx.materials.walls.find((w) => w.material_id === input.material_id);
  if (!material) return `ERROR: unknown wall material_id ${input.material_id}`;

  const targets: string[] = input.wall_object_names ?? [];
  ctx.state.hasSetWallColor = true;
  ctx.actions.push({
    type: "wall_color",
    wall_object_names: input.all_walls ? "all" : targets,
    material_id: material.material_id,
    hex_color: material.hex_color,
  });
  return `Wall color set to ${material.name}.`;
}

export function handleSetFloorMaterial(input: any, ctx: StagingContext): ToolResultContent {
  const material = ctx.materials.floors.find((f) => f.material_id === input.material_id);
  if (!material) return `ERROR: unknown floor material_id ${input.material_id}`;

  ctx.state.hasSetFloorMaterial = true;
  ctx.actions.push({
    type: "floor_material",
    material_id: material.material_id,
    diffuse_path: material.diffuse_path,
    normal_path: material.normal_path,
    roughness_path: material.roughness_path,
    tile_size_cm: material.tile_size_cm,
  });
  return `Floor material set to ${material.name}.`;
}

/** Lightweight, ad hoc "just show me a picture" check - a single top-down
 * plan view, no scoring. That one view is enough to judge spacing/overlaps/
 * traffic flow, which is what this ad hoc check is for - review_layout is the
 * heavier, gating tool for a real finishing pass. */
export async function handleRenderPreview(ctx: StagingContext): Promise<ToolResultContent> {
  const budgetError = checkRenderBudget(ctx, "render_preview");
  if (budgetError) return budgetError;
  ctx.state.renderCallCount++;

  const [view] = await ctx.renderSession.renderPreview({ scanData: ctx.serialized, actions: ctx.actions, views: ["top-down"] });
  return [
    { type: "text", text: "Top-down plan view:" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: view.buffer.toString("base64") } },
  ];
}

function scoredItemsFrom(ctx: StagingContext): ScoredItem[] {
  const items: ScoredItem[] = [];
  for (const [key, item] of ctx.state.slots) {
    const [widthM, , depthM] = glbGeometryService.dimensionsCm(item.localBox).map((cm) => cm / 100);
    const category = ctx.objectsByName.get(key)?.guessed_category;
    items.push({ key, position: item.position, rotationYDegrees: item.rotationYDegrees, widthM, depthM, category });
  }
  return items;
}

/** The heavier, gating finishing-pass tool: re-validates every current
 * placement against the FULL hard-constraint battery (a defensive re-check,
 * since adjust_placement never cascades a re-solve to items placed relative to
 * whatever it moved), computes soft scores, and renders the top-down plan view
 * - everything Claude needs for a single "is this room actually done" judgment
 * in one tool call. Only the top-down view: it's the one that actually shows
 * spacing/overlaps/traffic flow, which is what the hard constraints and scores
 * above it can't fully convey as plain numbers; style/realism is judged on the
 * final client-facing render instead, not on every in-loop check. */
export async function handleReviewLayout(ctx: StagingContext): Promise<ToolResultContent> {
  const budgetError = checkRenderBudget(ctx, "review_layout");
  if (budgetError) return budgetError;
  ctx.state.renderCallCount++;

  const footprintItems = [...ctx.state.slots.entries()].map(([key, item]) => ({ key, ...footprintOf(item) }));
  const violationsByItem = validateAllPlacements(footprintItems, ctx.geometry);
  ctx.state.lastReviewClean = violationsByItem.length === 0;

  const { scores, critique } = scoreLayout(scoredItemsFrom(ctx), ctx.geometry);

  const reportLines: string[] = [];
  if (violationsByItem.length === 0) {
    reportLines.push("Hard constraints: no violations.");
  } else {
    reportLines.push("Hard constraints - violations found:");
    for (const { key, violations } of violationsByItem) {
      reportLines.push(`- ${key}: ${violationsText(violations)}`);
    }
    reportLines.push("finish_staging will be rejected until these are fixed (adjust_placement/replace_furniture the affected items).");
  }
  reportLines.push("", `Scores (informational, never blocking): ${JSON.stringify(scores)}`, critique);

  const [view] = await ctx.renderSession.renderPreview({ scanData: ctx.serialized, actions: ctx.actions, views: ["top-down"] });
  return [
    { type: "text", text: reportLines.join("\n") },
    { type: "text", text: "Top-down plan view — check spacing, overlaps, clearances, traffic flow:" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: view.buffer.toString("base64") } },
  ];
}

export function handleFinishStaging(ctx: StagingContext): ToolResultContent {
  const missing: string[] = [];
  if (!ctx.state.hasSetWallColor) missing.push("set_wall_color");
  if (!ctx.state.hasSetFloorMaterial) missing.push("set_floor_material");
  if (!ctx.state.lastReviewClean) missing.push("review_layout (with zero remaining hard-constraint violations)");
  if (missing.length > 0) {
    return `ERROR: call ${missing.join(" and ")} before finishing.`;
  }
  return "Staging finished.";
}
