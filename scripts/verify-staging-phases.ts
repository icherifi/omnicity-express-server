/**
 * Standalone check for the depth-based phase system (stagingOrchestratorService.ts)
 * - the mechanism that stops Claude from ever being OFFERED a slot before
 * everything it depends on has resolved or been abandoned. Pure functions of
 * manifest + run state, no Claude API call anywhere in this script.
 *
 * Run: npx ts-node scripts/verify-staging-phases.ts
 */
import {
  buildTools,
  computePhase,
  computeSlotDepths,
  phasesEqual,
  preAbandonOrphanedDependents,
  Phase,
} from "../src/services/stagingOrchestratorService";
import { FlattenedSlot } from "../src/staging/roomManifests";
import { RunState } from "../src/services/stagingState";
import { applyForcedAlign, applyForcedFacing, applyForcedRelativeTo } from "../src/services/stagingToolHandlers";
import { PlacementIntent } from "../src/types/staging.types";

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  PASS: ${label}`);
  } else {
    failures++;
    console.log(`  FAIL: ${label}${detail ? ` (${detail})` : ""}`);
  }
}

function slot(partial: Partial<FlattenedSlot> & { slot_id: string }): FlattenedSlot {
  return {
    category: "test_category",
    item_no: "00000000",
    anchor_category: partial.depends_on_slot_id ? "dependent" : "independent",
    allowed_anchor_kinds: ["room_center"],
    zone_id: "zone_test",
    ...partial,
  };
}

function freshState(): RunState {
  return { lastReviewClean: false, renderCallCount: 0, slotAttempts: new Map(), slots: new Map() };
}

function placedItem() {
  return {
    itemNo: "00000000",
    modelSource: "ikea" as const,
    localBox: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] },
    position: [0, 0, 0] as [number, number, number],
    rotationYDegrees: 0,
    sourceKind: "placed" as const,
  };
}

// --- computeSlotDepths: the tv -> media_console -> sofa chain from the real
// living_dining manifest, the whole reason depth replaced a flat 2-phase split.
console.log("\n=== computeSlotDepths ===");
const chain: FlattenedSlot[] = [
  slot({ slot_id: "sofa" }),
  slot({ slot_id: "media_console", depends_on_slot_id: "sofa" }),
  slot({ slot_id: "tv", depends_on_slot_id: "media_console" }),
  slot({ slot_id: "armchair" }),
];
const depths = computeSlotDepths(chain);
check("independent slot (sofa) is depth 0", depths.get("sofa") === 0);
check("independent slot (armchair) is depth 0", depths.get("armchair") === 0);
check("direct dependent (media_console) is depth 1", depths.get("media_console") === 1);
check("second-order dependent (tv) is depth 2", depths.get("tv") === 2, `got ${depths.get("tv")}`);

console.log("\n=== computeSlotDepths: malformed references degrade to 0, not infinite loop ===");
const badRef: FlattenedSlot[] = [slot({ slot_id: "orphan", depends_on_slot_id: "does_not_exist" })];
const badRefDepths = computeSlotDepths(badRef);
check("a depends_on_slot_id pointing nowhere degrades to depth 0", badRefDepths.get("orphan") === 0);

const cycle: FlattenedSlot[] = [
  slot({ slot_id: "a", depends_on_slot_id: "b" }),
  slot({ slot_id: "b", depends_on_slot_id: "a" }),
];
const cycleDepths = computeSlotDepths(cycle);
check(
  "a real cycle terminates instead of infinite-looping (both sides finite)",
  Number.isFinite(cycleDepths.get("a")) && Number.isFinite(cycleDepths.get("b"))
);

// --- computePhase progression over the 3-level chain -------------------------
console.log("\n=== computePhase progression (sofa -> media_console -> tv) ===");
const state = freshState();
let phase = computePhase(chain, depths, state);
check("starts at depth 0 (sofa/armchair legal, media_console/tv not yet)", phase.kind === "depth" && phase.depth === 0, JSON.stringify(phase));

state.slots.set("sofa", placedItem());
state.slots.set("armchair", placedItem());
phase = computePhase(chain, depths, state);
check("advances to depth 1 once every depth-0 slot is done", phase.kind === "depth" && phase.depth === 1, JSON.stringify(phase));

state.slots.set("media_console", placedItem());
phase = computePhase(chain, depths, state);
check("advances to depth 2 once depth-1 is done", phase.kind === "depth" && phase.depth === 2, JSON.stringify(phase));

state.slots.set("tv", placedItem());
phase = computePhase(chain, depths, state);
check("advances to cleanup once every depth is done", phase.kind === "cleanup", JSON.stringify(phase));

// --- preAbandonOrphanedDependents: a dependent slot whose target never landed
console.log("\n=== preAbandonOrphanedDependents ===");
const orphanState = freshState();
const orphanChain: FlattenedSlot[] = [slot({ slot_id: "sofa" }), slot({ slot_id: "media_console", depends_on_slot_id: "sofa" })];
const orphanDepths = computeSlotDepths(orphanChain);
// sofa exhausted its attempts without ever landing in state.slots.
orphanState.slotAttempts.set("sofa", 3);
preAbandonOrphanedDependents(orphanChain, orphanState);
check(
  "media_console is pre-abandoned the moment its target (sofa) is given up on, without ever being offered",
  (orphanState.slotAttempts.get("media_console") ?? 0) >= 3
);
const orphanPhase = computePhase(orphanChain, orphanDepths, orphanState);
check("phase moves straight to cleanup - nothing left to legally offer at any depth", orphanPhase.kind === "cleanup", JSON.stringify(orphanPhase));

console.log("\n=== preAbandonOrphanedDependents: must NOT fire before the target's own phase even starts ===");
// The exact bug this test caught pre-fix: a dependent's target is trivially
// "not yet in state.slots" from round 1 onward, before it's even been
// attempted - that must not be treated as "the target failed."
const freshChain: FlattenedSlot[] = [slot({ slot_id: "sofa" }), slot({ slot_id: "media_console", depends_on_slot_id: "sofa" })];
const freshChainState = freshState();
preAbandonOrphanedDependents(freshChain, freshChainState);
check(
  "media_console is NOT pre-abandoned on round 1, before sofa has ever been attempted",
  (freshChainState.slotAttempts.get("media_console") ?? 0) < 3,
  `attempts=${freshChainState.slotAttempts.get("media_console") ?? 0}`
);

// --- phasesEqual ---------------------------------------------------------------
console.log("\n=== phasesEqual ===");
const d0: Phase = { kind: "depth", depth: 0 };
const d0b: Phase = { kind: "depth", depth: 0 };
const d1: Phase = { kind: "depth", depth: 1 };
const cleanup: Phase = { kind: "cleanup" };
const cleanupB: Phase = { kind: "cleanup" };
check("two depth-0 phases are equal", phasesEqual(d0, d0b));
check("depth-0 and depth-1 are not equal", !phasesEqual(d0, d1));
check("two cleanup phases are equal", phasesEqual(cleanup, cleanupB));
check("depth and cleanup are never equal", !phasesEqual(d0, cleanup) && !phasesEqual(cleanup, d0));

// --- buildTools: the actual caching fix - the enum must be the FULL static
// per-depth list, not the shrinking "remaining" list, or the tools array (and
// thus the cached prompt prefix) changes on every successful placement instead
// of only at phase boundaries (confirmed directly on a real run: cache_creation
// exceeded cache_read for the WHOLE run before this fix).
console.log("\n=== buildTools: stable enum within a phase, correct tool set per phase ===");
const depth0Tools = buildTools({ kind: "depth", depth: 0 }, chain, depths);
const placeTool0 = depth0Tools.find((t) => t.name === "place_manifest_item");
check("depth-0 tools include place_manifest_item", !!placeTool0);
const enum0Before = (placeTool0?.input_schema as { properties: { slot_id: { enum: string[] } } }).properties.slot_id.enum;
check(
  "depth-0 enum is exactly the two depth-0 slot_ids, unordered-safe",
  new Set(enum0Before).size === 2 && enum0Before.includes("sofa") && enum0Before.includes("armchair"),
  JSON.stringify(enum0Before)
);

const stateAfterSofaPlaced = freshState();
stateAfterSofaPlaced.slots.set("sofa", placedItem());
const depth0ToolsAfterProgress = buildTools({ kind: "depth", depth: 0 }, chain, depths);
const enum0After = (depth0ToolsAfterProgress.find((t) => t.name === "place_manifest_item")?.input_schema as { properties: { slot_id: { enum: string[] } } })
  .properties.slot_id.enum;
check(
  "the SAME depth's enum is byte-identical after a slot succeeds (the actual caching fix - buildTools takes no run state)",
  JSON.stringify([...enum0Before].sort()) === JSON.stringify([...enum0After].sort())
);

check("depth-0 tools do NOT include adjust_placement/finish_staging", !depth0Tools.some((t) => t.name === "adjust_placement" || t.name === "finish_staging"));

const cleanupTools = buildTools({ kind: "cleanup" }, chain, depths);
check("cleanup tools include adjust_placement and finish_staging", cleanupTools.some((t) => t.name === "adjust_placement") && cleanupTools.some((t) => t.name === "finish_staging"));
check("cleanup tools do NOT include place_manifest_item", !cleanupTools.some((t) => t.name === "place_manifest_item"));

for (const phaseTools of [depth0Tools, cleanupTools]) {
  check("every phase always includes render_preview and review_layout", phaseTools.some((t) => t.name === "render_preview") && phaseTools.some((t) => t.name === "review_layout"));
}

// --- applyForcedFacing: dining chairs must face the table, not match its own
// facing (the left_of/right_of default) - the bug this manifest-level override
// exists to fix.
console.log("\n=== applyForcedFacing ===");
const chairSlot = slot({
  slot_id: "dining_chair_1",
  depends_on_slot_id: "dining_table",
  forced_facing: "toward_depends_on_target",
});
const chairIntentNoFacing: PlacementIntent = { anchor: { kind: "relative_to", target_id: "dining_table", relation: "left_of" } };
const forcedIntent = applyForcedFacing(chairSlot, chairIntentNoFacing);
check(
  "forced_facing injects facing:toward_object at the depends_on_slot_id when Claude omitted facing",
  forcedIntent.facing?.kind === "toward_object" && (forcedIntent.facing as { target_id: string }).target_id === "dining_table",
  JSON.stringify(forcedIntent.facing)
);

const chairIntentWithFacing: PlacementIntent = {
  anchor: { kind: "relative_to", target_id: "dining_table", relation: "left_of" },
  facing: { kind: "explicit_degrees", degrees: 42 },
};
const overriddenIntent = applyForcedFacing(chairSlot, chairIntentWithFacing);
check(
  "forced_facing OVERRIDES whatever facing Claude explicitly supplied, not just fills in a gap",
  overriddenIntent.facing?.kind === "toward_object",
  JSON.stringify(overriddenIntent.facing)
);
check(
  "the anchor itself is untouched by forced_facing - only facing changes",
  overriddenIntent.anchor === chairIntentWithFacing.anchor
);

const noForcedFacingSlot = slot({ slot_id: "nightstand_left", depends_on_slot_id: "bed" });
const nightstandIntent: PlacementIntent = { anchor: { kind: "relative_to", target_id: "bed", relation: "left_of" } };
const untouchedIntent = applyForcedFacing(noForcedFacingSlot, nightstandIntent);
check("a slot with no forced_facing passes the intent through completely unchanged", untouchedIntent === nightstandIntent);

const independentSlotWithStrayFlag = slot({ slot_id: "sofa", forced_facing: "toward_depends_on_target" });
const sofaIntent: PlacementIntent = { anchor: { kind: "against_wall", wall_id: "wall_1" } };
const sofaResultIntent = applyForcedFacing(independentSlotWithStrayFlag, sofaIntent);
check(
  "forced_facing is a no-op without a depends_on_slot_id, even if the flag were set by mistake (defensive, not expected in a well-formed manifest)",
  sofaResultIntent === sofaIntent
);

// --- forced_facing: "anchor_default" - strips facing entirely so the
// anchor's own deterministic default (e.g. zone_center's nearestWallRotation)
// can never be overridden, closing the gap where nearestWallRotation only
// fixed the DEFAULT but Claude could still send an explicit facing to re-tilt
// the table.
console.log('\n=== applyForcedFacing: "anchor_default" ===');
const diningTableSlot = slot({ slot_id: "dining_table", forced_facing: "anchor_default" });
const tableIntentNoFacing: PlacementIntent = { anchor: { kind: "zone_center", zone_id: "zone_living_dining_1" } };
const tableUnchanged = applyForcedFacing(diningTableSlot, tableIntentNoFacing);
check("anchor_default is a no-op when Claude already omitted facing", tableUnchanged.facing === undefined);

const tableIntentWithFacing: PlacementIntent = {
  anchor: { kind: "zone_center", zone_id: "zone_living_dining_1" },
  facing: { kind: "explicit_degrees", degrees: 17 },
  nudge_cm: { forward: 10 },
};
const tableStripped = applyForcedFacing(diningTableSlot, tableIntentWithFacing);
check(
  "anchor_default STRIPS an explicit facing Claude supplied - the actual gap this closes (nearestWallRotation was only ever the fallback default, not enforced)",
  tableStripped.facing === undefined,
  JSON.stringify(tableStripped)
);
check("anchor_default preserves the anchor and nudge_cm untouched, only facing is dropped", tableStripped.anchor === tableIntentWithFacing.anchor && tableStripped.nudge_cm === tableIntentWithFacing.nudge_cm);

// --- applyForcedAlign: coffee table must be CENTERED on the sofa, not
// edge-aligned (in_front_of's default when align is omitted) - the gap that
// broke the shared sofa/coffee-table/console/TV axis.
console.log("\n=== applyForcedAlign ===");
const coffeeTableSlot = slot({ slot_id: "coffee_table", depends_on_slot_id: "sofa", forced_align: "center" });
const coffeeIntentNoAlign: PlacementIntent = { anchor: { kind: "relative_to", target_id: "sofa", relation: "in_front_of" } };
const coffeeForced = applyForcedAlign(coffeeTableSlot, coffeeIntentNoAlign);
check(
  "forced_align injects align:center onto the anchor when Claude omitted it (the default would otherwise be edge-aligned, not centered)",
  coffeeForced.anchor.kind === "relative_to" && coffeeForced.anchor.align === "center",
  JSON.stringify(coffeeForced.anchor)
);

const coffeeIntentWithAlign: PlacementIntent = { anchor: { kind: "relative_to", target_id: "sofa", relation: "in_front_of", align: "end" } };
const coffeeOverridden = applyForcedAlign(coffeeTableSlot, coffeeIntentWithAlign);
check(
  "forced_align OVERRIDES whatever align Claude explicitly supplied, not just fills in a gap",
  coffeeOverridden.anchor.kind === "relative_to" && coffeeOverridden.anchor.align === "center",
  JSON.stringify(coffeeOverridden.anchor)
);

const nightstandNoForcedAlign = slot({ slot_id: "nightstand_left", depends_on_slot_id: "bed" });
const nightstandAlignIntent: PlacementIntent = { anchor: { kind: "relative_to", target_id: "bed", relation: "left_of" } };
const nightstandUntouched = applyForcedAlign(nightstandNoForcedAlign, nightstandAlignIntent);
check("a slot with no forced_align passes the intent through completely unchanged", nightstandUntouched === nightstandAlignIntent);

const nonRelativeSlotWithStrayAlign = slot({ slot_id: "dining_table", forced_align: "center" });
const nonRelativeIntent: PlacementIntent = { anchor: { kind: "zone_center", zone_id: "zone_living_dining_1" } };
const nonRelativeResult = applyForcedAlign(nonRelativeSlotWithStrayAlign, nonRelativeIntent);
check(
  "forced_align is a no-op on a non-relative_to anchor, even if the flag were set by mistake (defensive, not expected in a well-formed manifest)",
  nonRelativeResult === nonRelativeIntent
);

// --- applyForcedRelativeTo: the dining-table-chairs deterministic block -----
console.log("\n=== applyForcedRelativeTo ===");
const chairSlotForced = slot({
  slot_id: "dining_chair_1",
  depends_on_slot_id: "dining_table",
  forced_relative_to: { relation: "left_of", align: "center", gap_cm: -8 },
});
const claudesOwnIntent: PlacementIntent = {
  anchor: { kind: "relative_to", target_id: "dining_table", relation: "behind", align: "start", gap_cm: 20 },
};
const forcedRelIntent = applyForcedRelativeTo(chairSlotForced, claudesOwnIntent);
check(
  "forced_relative_to reconstructs the WHOLE anchor from the manifest, ignoring relation/align/gap_cm Claude sent",
  forcedRelIntent.anchor.kind === "relative_to" &&
    forcedRelIntent.anchor.target_id === "dining_table" &&
    forcedRelIntent.anchor.relation === "left_of" &&
    forcedRelIntent.anchor.align === "center" &&
    forcedRelIntent.anchor.gap_cm === -8,
  JSON.stringify(forcedRelIntent.anchor)
);
check(
  "target_id always comes from depends_on_slot_id, even though Claude's own intent pointed at the same target - never taken from Claude's anchor",
  forcedRelIntent.anchor.kind === "relative_to" && forcedRelIntent.anchor.target_id === chairSlotForced.depends_on_slot_id
);

const noForcedRelSlot = slot({ slot_id: "coffee_table", depends_on_slot_id: "sofa", forced_align: "center" });
const coffeeIntent: PlacementIntent = { anchor: { kind: "relative_to", target_id: "sofa", relation: "in_front_of" } };
const untouchedRelIntent = applyForcedRelativeTo(noForcedRelSlot, coffeeIntent);
check("a slot with no forced_relative_to (e.g. coffee_table, which only forces align) passes the intent through unchanged", untouchedRelIntent === coffeeIntent);

const independentSlotWithStrayForcedRel = slot({ slot_id: "sofa", forced_relative_to: { relation: "left_of" } });
const sofaAnchorIntent: PlacementIntent = { anchor: { kind: "against_wall", wall_id: "wall_1" } };
const strayRelResult = applyForcedRelativeTo(independentSlotWithStrayForcedRel, sofaAnchorIntent);
check(
  "forced_relative_to is a no-op without a depends_on_slot_id, even if the flag were set by mistake (defensive, not expected in a well-formed manifest)",
  strayRelResult === sofaAnchorIntent
);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
