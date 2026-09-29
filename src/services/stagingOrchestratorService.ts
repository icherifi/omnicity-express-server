import Anthropic from "@anthropic-ai/sdk";
import * as ikeaService from "./ikeaService";
import * as localModelService from "./localModelService";
import * as glbGeometryService from "./glbGeometryService";
import { buildRoomGeometry, inspectRoom } from "./roomShellService";
import { classifyZones } from "./roomZoningService";
import { stripFurniture } from "./furnitureStrippingService";
import { buildDefaultMaterialActions, getMaterials } from "./materialsService";
import { FlattenedSlot, selectAndFlattenManifests } from "../staging/roomManifests";
import { StagingRenderSession } from "./stagingRenderService";
import { PlacedItem, RunState, StagingContext } from "./stagingState";
import {
  handleAdjustPlacement,
  handleFinishStaging,
  handlePlaceManifestItem,
  handleRenderPreview,
  handleReviewLayout,
  MAX_SLOT_ATTEMPTS,
  ToolResultContent,
} from "./stagingToolHandlers";
import { RoomPlanCapturedRoom, SceneInspection, StagingSummary } from "../types/staging.types";

const DEFAULT_MODEL = process.env.ANTHROPIC_STAGING_MODEL || "claude-sonnet-5";
// output_config.effort only exists on current-generation models (Sonnet 5,
// Opus 5, Fable 5/5.1, Opus 4.6-4.8) - Haiku 4.5 rejects it outright with a
// 400 ("This model does not support the effort parameter"), confirmed
// directly. Haiku uses the older enabled/budget_tokens thinking style instead,
// which this app doesn't need to opt into (no thinking is a fine default for
// this now-mechanical, bounded-choice task).
const MODEL_SUPPORTS_EFFORT = !DEFAULT_MODEL.includes("haiku");
// Left unchanged from the pre-manifest design for now - product selection
// (search_ikea/get_ikea_product) and wall/floor choice are both gone, which
// should sharply cut real round usage for the same amount of work, but
// re-tuning this without a real run to measure against would be a guess, not
// a decision. Revisit after the first real end-to-end run under this design.
const MAX_TOOL_ROUNDS = 20;
// With ~2 rounds left and the room still not passing review_layout clean, nudge
// Claude to converge immediately rather than silently exhausting the budget.
const CONVERGENCE_WARNING_ROUNDS_REMAINING = 2;
// MAX_SLOT_ATTEMPTS imported from stagingToolHandlers.ts (the file that
// actually enforces it) - used here for the phase-completion check
// (remainingSlotIds/computePhase below) so both stay in sync by construction.

function anthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY environment variable");
  // A hung request here previously left a scan stuck in "processing" forever - nothing
  // ever reached the catch block in staging.ts to mark it "error". Bound it explicitly
  // rather than trust an unbounded default (10 minutes).
  //
  // 240s per attempt (not the SDK's default 120s): a turn that batches several
  // independent tool calls can legitimately take longer to generate than a
  // single-tool-call turn. Still capped at 1 retry (worst case ~8 minutes
  // total) rather than trusting an unbounded default.
  return new Anthropic({ apiKey, timeout: 240_000, maxRetries: 1 });
}

const PLACEMENT_ANCHOR_SCHEMA = {
  type: "object",
  description:
    "Where the item goes, expressed relationally - never as raw coordinates. Exactly one of these shapes. Must be one of the slot's own allowed_anchor_kinds (see the manifest in the room geometry).",
  properties: {
    kind: { type: "string", enum: ["against_wall", "in_corner", "room_center", "relative_to", "zone_center", "facing_target_wall"] },
    wall_id: { type: "string", description: "against_wall: the wall's identifier (see walls[].object_name in the room geometry)." },
    along: {
      description: "against_wall only. Omit to center in the largest free stretch of the wall.",
      oneOf: [
        { type: "string", enum: ["center"] },
        {
          type: "object",
          properties: { from_corner: { type: "string", enum: ["start", "end"] }, offset_cm: { type: "number" } },
          required: ["from_corner", "offset_cm"],
        },
      ],
    },
    wall_id_a: { type: "string", description: "in_corner: the first of the two walls forming the corner." },
    wall_id_b: { type: "string", description: "in_corner: the second wall." },
    target_id: {
      type: "string",
      description:
        "relative_to/facing_target_wall: the slot_id of an already-placed item to position against (relative_to) or find the facing wall of (facing_target_wall).",
    },
    relation: {
      type: "string",
      enum: ["left_of", "right_of", "in_front_of", "behind", "on_top_of"],
      description: "relative_to only. on_top_of stacks on the target's own top surface (e.g. a TV on a media console) - the only relation that changes height.",
    },
    align: { type: "string", enum: ["center", "start", "end"], description: "relative_to only (not on_top_of). Default depends on relation." },
    gap_cm: {
      type: "number",
      description: "against_wall/in_corner/relative_to/facing_target_wall: extra clearance beyond the minimum touching distance. Default 0 (5cm for relative_to).",
    },
    zone_id: { type: "string", description: "zone_center: the id of the zone to center in (see zones in the room geometry)." },
    sub_region: {
      type: "string",
      enum: ["half_a", "half_b"],
      description: "zone_center only. Omit for the zone's plain centroid; otherwise splits the zone along its longer axis (half_a = closer to the whole floor's center, half_b = farther).",
    },
  },
  required: ["kind"],
};

const FACING_SCHEMA = {
  type: "object",
  description:
    "Optional - which way the item faces. Omit to use the sensible default for the anchor (away from the wall, matching or facing the relative_to target).",
  properties: {
    kind: {
      type: "string",
      enum: ["away_from_wall", "match_target", "toward_target", "toward_room_center", "toward_object", "toward_wall", "toward_window", "explicit_degrees"],
    },
    target_id: { type: "string", description: "toward_object only." },
    wall_id: { type: "string", description: "toward_wall only." },
    window_id: { type: "string", description: "toward_window only." },
    degrees: { type: "number", description: "explicit_degrees only - escape hatch for anything the other options can't express." },
  },
  required: ["kind"],
};

const PLACEMENT_INTENT_SCHEMA = {
  type: "object",
  properties: {
    anchor: PLACEMENT_ANCHOR_SCHEMA,
    facing: FACING_SCHEMA,
    nudge_cm: {
      type: "object",
      description: "Optional small fine-tune (+-40cm each axis, clamped) in the item's OWN forward/lateral direction after anchor+facing are solved. Not a way to place things freely - use a different anchor for that.",
      properties: {
        forward: { type: "number", minimum: -40, maximum: 40 },
        lateral: { type: "number", minimum: -40, maximum: 40 },
      },
    },
  },
  required: ["anchor"],
};

// --- Phase computation --------------------------------------------------------
// Which tool calls are LEGAL this round is a pure function of
// orchestrator-tracked state, recomputed every round - not left to Claude's
// discretion. A slot is never offered until everything it depends on has
// resolved or been given up on. Generalized to N dependency levels (depth),
// not just independent/dependent: a chain like tv -> media_console -> sofa
// needs its own ordered phase per link.

export type Phase = { kind: "depth"; depth: number } | { kind: "cleanup" };

export function phasesEqual(a: Phase, b: Phase): boolean {
  return a.kind === "cleanup" ? b.kind === "cleanup" : b.kind === "depth" && a.depth === b.depth;
}

function isSlotDone(state: RunState, slotId: string): boolean {
  return state.slots.has(slotId) || (state.slotAttempts.get(slotId) ?? 0) >= MAX_SLOT_ATTEMPTS;
}

/** 0 for a slot with no depends_on_slot_id, otherwise 1 + its target's own
 * depth - computed from the manifest's static dependency graph (never run
 * state), so it's the same every round. A malformed reference (points at a
 * slot_id that doesn't exist, or a real cycle) degrades to depth 0 rather than
 * infinite-looping - defensive against a manifest-authoring mistake, not
 * something a well-formed manifest should ever hit. */
function slotDepth(slot: FlattenedSlot, byId: Map<string, FlattenedSlot>, seen: Set<string>): number {
  if (!slot.depends_on_slot_id || seen.has(slot.slot_id)) return 0;
  const target = byId.get(slot.depends_on_slot_id);
  if (!target) return 0;
  return 1 + slotDepth(target, byId, new Set(seen).add(slot.slot_id));
}

export function computeSlotDepths(manifestSlots: FlattenedSlot[]): Map<string, number> {
  const byId = new Map(manifestSlots.map((s) => [s.slot_id, s]));
  return new Map(manifestSlots.map((s) => [s.slot_id, slotDepth(s, byId, new Set())]));
}

function remainingSlotIdsAtDepth(manifestSlots: FlattenedSlot[], depths: Map<string, number>, state: RunState, depth: number): string[] {
  return manifestSlots.filter((s) => depths.get(s.slot_id) === depth && !isSlotDone(state, s.slot_id)).map((s) => s.slot_id);
}

/** The FULL static slot_id list for a depth level, regardless of resolution
 * status - unlike remainingSlotIdsAtDepth, this never shrinks as slots
 * succeed. Used for the tool schema's enum (see buildTools): a shrinking enum
 * would change the tools array - and thus the cached system+tools prefix -
 * on almost every round instead of only at phase boundaries. An already-done
 * slot_id staying in the enum is harmless: handlePlaceManifestItem already
 * rejects a re-attempt on an already-placed or abandoned slot. */
export function allSlotIdsAtDepth(manifestSlots: FlattenedSlot[], depths: Map<string, number>, depth: number): string[] {
  return manifestSlots.filter((s) => depths.get(s.slot_id) === depth).map((s) => s.slot_id);
}

/** A slot whose target CONCLUDED (attempts exhausted, or its phase closed)
 * without ever landing can never succeed - mark it given-up without ever
 * offering it to Claude. Must check the target's OWN isSlotDone, not just
 * "not yet in state.slots": every dependent's target is trivially "not yet
 * placed" before the target's own phase even starts, so that weaker check
 * would abandon every dependent slot on round 1. Idempotent, and correct at
 * any depth - cascades one level at a time as each phase concludes. */
export function preAbandonOrphanedDependents(manifestSlots: FlattenedSlot[], state: RunState): void {
  for (const slot of manifestSlots) {
    if (!slot.depends_on_slot_id || isSlotDone(state, slot.slot_id)) continue;
    const targetId = slot.depends_on_slot_id;
    if (isSlotDone(state, targetId) && !state.slots.has(targetId)) {
      state.slotAttempts.set(slot.slot_id, MAX_SLOT_ATTEMPTS);
    }
  }
}

export function computePhase(manifestSlots: FlattenedSlot[], depths: Map<string, number>, state: RunState): Phase {
  preAbandonOrphanedDependents(manifestSlots, state);
  const maxDepth = manifestSlots.length === 0 ? -1 : Math.max(...manifestSlots.map((s) => depths.get(s.slot_id) ?? 0));
  for (let depth = 0; depth <= maxDepth; depth++) {
    if (remainingSlotIdsAtDepth(manifestSlots, depths, state, depth).length > 0) return { kind: "depth", depth };
  }
  return { kind: "cleanup" };
}

export function buildTools(phase: Phase, manifestSlots: FlattenedSlot[], depths: Map<string, number>): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];

  if (phase.kind === "depth") {
    const legalSlotIds = allSlotIdsAtDepth(manifestSlots, depths, phase.depth);
    tools.push({
      name: "place_manifest_item",
      description:
        "Places one manifest item via a placement intent - a solver resolves it to exact geometry and validates it against the room. slot_id is fixed by the manifest, never invented; only the current phase's slot_ids are legal. Rejected with a specific reason if invalid - try another anchor within the slot's allowed_anchor_kinds. Returns real dimensions (cm).",
      input_schema: {
        type: "object",
        properties: {
          slot_id: { type: "string", enum: legalSlotIds },
          intent: PLACEMENT_INTENT_SCHEMA,
        },
        required: ["slot_id", "intent"],
      },
    });
  }

  if (phase.kind === "cleanup") {
    tools.push({
      name: "adjust_placement",
      description:
        "Re-solves an already-placed slot's position/rotation with a new intent - same catalog item. Use to fix a facing that defaulted early, or to act on review_layout feedback.",
      input_schema: {
        type: "object",
        properties: {
          slot_id: { type: "string" },
          intent: PLACEMENT_INTENT_SCHEMA,
        },
        required: ["slot_id", "intent"],
      },
    });
    tools.push({
      name: "finish_staging",
      description: "Call once the room is realistic and sellable. Rejected unless the latest review_layout was clean (zero violations).",
      input_schema: {
        type: "object",
        properties: { notes: { type: "string", description: "Short summary of the placement choices and why." } },
        required: ["notes"],
      },
    });
  }

  tools.push({
    name: "render_preview",
    description:
      "Ad hoc top-down look, no scoring. Shares a 5-call budget with review_layout for the WHOLE room - don't call after every placement. Use review_layout (not this) before finish_staging.",
    input_schema: { type: "object", properties: {} },
  });
  tools.push({
    name: "review_layout",
    description:
      "Finishing-pass check: re-validates hard constraints (collisions, door/window clearance, floor shape) and renders a top-down view. Required clean (zero violations) on its LATEST call before finish_staging - call again after fixing flags. Shares the SAME 5-call budget as render_preview; the last call is always reserved for this tool.",
    input_schema: { type: "object", properties: {} },
  });

  return tools;
}

/** Every unique item_no's real physical footprint, measured once up front from
 * its actual GLB (never from catalog metadata - IKEA's product APIs carry no
 * numeric dimension field at all). Keyed by item_no rather than by slot since
 * several slots can share one (e.g. both nightstands). Must route by
 * model_source per item_no - a "local" id like a TV's model is meaningless to
 * ikeaService.getModel and would hard-fail the whole run at startup. */
async function prefetchDimensionsByItemNo(manifestSlots: FlattenedSlot[]): Promise<Map<string, [number, number, number]>> {
  const uniqueItemNos = [...new Set(manifestSlots.map((s) => s.item_no))];
  const dimensionsByItemNo = new Map<string, [number, number, number]>();
  for (const itemNo of uniqueItemNos) {
    const modelSource = manifestSlots.find((s) => s.item_no === itemNo)?.model_source ?? "ikea";
    const glbPath = modelSource === "local" ? await localModelService.getModel(itemNo) : await ikeaService.getModel(itemNo);
    const box = glbGeometryService.computeLocalBoundingBox(glbPath);
    dimensionsByItemNo.set(itemNo, glbGeometryService.dimensionsCm(box));
  }
  return dimensionsByItemNo;
}

/**
 * Deliberately fully static for the whole run (no round-dependent text) so this
 * is byte-identical on every call within one phase - the precondition for
 * prompt caching to hit. tools DOES vary by phase (see buildTools), so the
 * cache still misses once per phase transition (one miss per dependency depth
 * level plus cleanup - typically 3-4 times a run, not always) - a real, named
 * cost, but far better than every round paying full price. The round-based
 * convergence nudge and phase-transition notices both go in the tool-results
 * message instead (see runStaging), never here.
 */
function systemPrompt(
  inspection: SceneInspection,
  keptObjects: SceneInspection["objects"],
  zones: ReturnType<typeof buildPromptZones>,
  manifestForPrompt: ReturnType<typeof buildPromptManifest>
): string {
  return `Tu es un décorateur d'intérieur virtuel. La liste des meubles à installer est déjà déterminée à l'avance (manifeste ci-dessous, choisi automatiquement selon le type et la taille de chaque zone) — tu n'as AUCUN choix de produit à faire. Ton seul travail : décider OÙ placer chaque meuble de cette liste, à partir de la géométrie réelle de la pièce (murs, portes, fenêtres, autres meubles déjà placés). La couleur des murs et le matériau du sol sont déjà appliqués automatiquement, rien à faire à ce sujet.

Chaque meuble se place via une INTENTION relationnelle (against_wall/in_corner/zone_center/relative_to/room_center/facing_target_wall — détails dans le schéma de l'outil), jamais des coordonnées. Un solveur calcule la géométrie exacte et vérifie collisions, dégagement de porte/fenêtre, limites réelles du sol. Chaque slot du manifeste précise ses allowed_anchor_kinds — utilise uniquement un type d'ancre autorisé pour ce slot précis, l'appel est rejeté sinon. Pour certains slots, l'orientation finale (facing) est aussi imposée automatiquement par le système (ex. une chaise autour d'une table doit faire face à la table) — ce que tu passes dans facing pour ce slot est alors ignoré, pas la peine d'y réfléchir.

Le placement se fait en PLUSIEURS ÉTAPES imposées par le système, pas par choix, une par niveau de dépendance :
1. D'ABORD les meubles indépendants (against_wall/in_corner/room_center/zone_center) — ils ne dépendent d'aucun autre meuble.
2. ENSUITE les meubles qui dépendent d'un meuble du niveau précédent (relative_to/facing_target_wall) — une fois leur cible déjà posée. Un meuble peut lui-même dépendre d'un meuble dépendant (ex. une télé posée sur un meuble télé qui lui-même fait face à un canapé) — chaque niveau de cette chaîne a son propre tour, dans l'ordre.
Le sous-ensemble de slot_id que tu peux passer à place_manifest_item change automatiquement d'une étape à l'autre (visible dans le schéma de l'outil à chaque tour) — tu n'as pas besoin de suivre toi-même l'ordre, le système ne proposera jamais un slot avant que sa cible existe.

Contraintes de budget IMPORTANTES :
- Tu disposes d'environ ${MAX_TOOL_ROUNDS} tours d'outils pour TOUTE la pièce. Un tour peut contenir PLUSIEURS appels indépendants à la fois — dès que plusieurs slots de l'étape en cours n'ont AUCUNE dépendance entre eux, lance leurs place_manifest_item dans le MÊME tour plutôt qu'un par un.
- render_preview et review_layout partagent un budget total de 5 appels pour toute la pièce — n'appelle PAS ces outils après chaque placement individuel. Place un maximum de meubles d'abord, puis vérifie visuellement. Garde toujours au moins 1 appel en réserve pour le review_layout final obligatoire.
- Si un slot résiste après ${MAX_SLOT_ATTEMPTS} tentatives infructueuses, le système l'abandonne automatiquement et passe à la suite — inutile d'insister au-delà.

Règles :
- Pour against_wall, OMETS le champ "along" dès ta première tentative sur un slot donné : le solveur choisit alors automatiquement le plus grand espace libre du mur, en tenant déjà compte des meubles déjà placés — c'est presque toujours un meilleur premier essai qu'un offset choisi à la main. Ne précise "along" que pour un besoin précis (ex. coller un meuble à une extrémité), ou après un premier échec.
- Pour zone_center (ex. la table à manger) : le repli par défaut (sans "facing") aligne déjà l'objet parallèlement au mur le plus proche — jamais d'angle aléatoire. Mais TOI seul peux juger de la meilleure orientation pour économiser de la place : chaque zone du contexte ci-dessous donne bounds_min/bounds_max (l'étendue réelle en largeur/profondeur), pas seulement l'aire — si la zone est nettement plus longue dans un sens, orienter le grand axe de la table dans CE sens (facing: {kind: "explicit_degrees", degrees: ...}, aligné avec un mur réel) réduit l'espace perdu autour, par exemple pour laisser assez de place aux chaises sans déborder sur une zone voisine.
- Si une intention échoue (mur inconnu, pas assez de place, cible relative_to pas encore placée, zone inconnue), le message d'erreur explique pourquoi — essaie une autre ancre parmi celles autorisées pour ce slot. Ne réessaie jamais avec des coordonnées brutes, cette option n'existe pas.
- Une fois toutes les étapes de placement terminées, utilise review_layout (contraintes dures + rendu) et corrige (adjust_placement) tout ce qu'il signale, puis relance-le jusqu'à ce qu'il soit propre.
- adjust_placement corrige un meuble déjà placé (ex. une orientation qui a utilisé un repli par défaut parce que sa cible n'existait pas encore au moment du placement) sans changer l'article.
- Quand review_layout est propre, appelle finish_staging avec un résumé court des choix de placement faits.

Équipements fixes du scan (contexte uniquement — NE JAMAIS essayer de les déplacer ou les remplacer, ils restent visibles tels quels) :
${JSON.stringify(keptObjects, null, 2)}

Zones de la pièce (calculées automatiquement à partir du scan) :
${JSON.stringify(zones, null, 2)}

Manifeste de mobilier assigné à ce run (dimensions réelles mesurées à l'avance) :
${JSON.stringify(manifestForPrompt, null, 2)}

Murs, portes, fenêtres, et forme du sol (issus du scan) :
${JSON.stringify({ room: inspection.room, walls: visibleWalls(inspection.walls), doors: inspection.doors, windows: inspection.windows }, null, 2)}`;
}

// Below this, a wall is never a real placement candidate for anything in any
// current manifest (the narrowest against_wall/in_corner item is the
// armchair at ~59cm). An open-plan apartment's doors/openings can fragment
// its walls into many short, unusable pieces, burying the few real
// candidates in noise Claude has to sift through in prose with a limited
// attempt budget. Only trims what's shown in the prompt - geometry.walls
// (every hard-constraint check, corner-finding, etc.) is untouched.
const MIN_WALL_WIDTH_CM_SHOWN = 60;
function visibleWalls(walls: SceneInspection["walls"]): SceneInspection["walls"] {
  return walls.filter((w) => w.dimensions_cm[0] >= MIN_WALL_WIDTH_CM_SHOWN);
}

// bounds_min/bounds_max included, not just area_m2 - a single area number
// can't tell Claude whether a zone is long/narrow or roughly square, which it
// needs to judge which way a table should run to save space (see
// systemPrompt's own guidance on this).
function buildPromptZones(
  geometry: { zones: { id: string; label: string; centroid: [number, number]; area_m2: number; bounds_min: [number, number]; bounds_max: [number, number] }[] }
) {
  return geometry.zones.map((z) => ({
    id: z.id,
    label: z.label,
    centroid: z.centroid,
    area_m2: Math.round(z.area_m2 * 10) / 10,
    bounds_min: z.bounds_min,
    bounds_max: z.bounds_max,
  }));
}

// depends_on_slot_id is deliberately NOT shown here - it's pure orchestrator
// bookkeeping (the phase-B pre-abandon check), and fully redundant for Claude's
// purposes with what `notes` already spells out in prose ("relative_to le slot
// X, relation Y") wherever it matters. Cuts one field's worth of tokens per
// slot in the manifest that gets cached at every phase boundary.
function buildPromptManifest(manifestSlots: FlattenedSlot[], dimensionsByItemNo: Map<string, [number, number, number]>) {
  return manifestSlots.map((s) => ({
    slot_id: s.slot_id,
    zone_id: s.zone_id,
    category: s.category,
    dimensions_cm: dimensionsByItemNo.get(s.item_no),
    anchor_category: s.anchor_category,
    allowed_anchor_kinds: s.allowed_anchor_kinds,
    notes: s.notes,
  }));
}

async function callTool(name: string, input: any, ctx: StagingContext): Promise<ToolResultContent> {
  console.log(`[staging] ${name}(${JSON.stringify(input)})`);
  try {
    switch (name) {
      case "place_manifest_item":
        return await handlePlaceManifestItem(input, ctx);
      case "adjust_placement":
        return await handleAdjustPlacement(input, ctx);
      case "render_preview":
        return await handleRenderPreview(ctx);
      case "review_layout":
        return await handleReviewLayout(ctx);
      case "finish_staging":
        return handleFinishStaging(ctx);
      default:
        return `ERROR: unknown tool ${name}`;
    }
  } catch (e: any) {
    const message = e?.message ?? String(e);
    ctx.errors.push(message);
    return `ERROR: ${message}`;
  }
}

export interface RunStagingResult {
  summary: StagingSummary;
  previewBuffer: Buffer;
}

export async function runStaging(serialized: RoomPlanCapturedRoom): Promise<RunStagingResult> {
  const anthropic = anthropicClient();
  const inspection = inspectRoom(serialized);
  const geometry = buildRoomGeometry(serialized, inspection.room);
  const { zones, objectZoneAssignments } = classifyZones(geometry, inspection.sections, inspection.objects);
  geometry.zones = zones;

  const { kept, stripped } = stripFurniture(inspection.objects, zones, objectZoneAssignments);
  const manifestSlotsFlat = selectAndFlattenManifests(zones);
  const slotDepths = computeSlotDepths(manifestSlotsFlat);
  const dimensionsByItemNo = await prefetchDimensionsByItemNo(manifestSlotsFlat);
  const materials = getMaterials();

  const objectsByName = new Map(kept.map((o) => [o.object_name, o]));
  const manifestSlots = new Map(manifestSlotsFlat.map((s) => [s.slot_id, s]));

  const actions: StagingContext["actions"] = [...buildDefaultMaterialActions(materials)];
  const errors: string[] = [];

  const slots = new Map<string, PlacedItem>();
  for (const obj of kept) {
    const [w, h, d] = obj.dimensions_cm.map((cm) => cm / 100);
    slots.set(obj.object_name, {
      itemNo: "",
      modelSource: "ikea", // meaningless for fixed equipment (no real GLB, never re-fetched) - arbitrary default to satisfy the type
      localBox: { min: [-w / 2, -h / 2, -d / 2], max: [w / 2, h / 2, d / 2] },
      position: obj.position,
      rotationYDegrees: obj.rotation_y_degrees,
      sourceKind: "fixed_equipment",
    });
  }

  const state: RunState = {
    lastReviewClean: false,
    renderCallCount: 0,
    slotAttempts: new Map(),
    slots,
  };

  const strippedRoomplanIdentifiers = stripped.map((o) => o.roomplan_identifier).filter((id): id is string => !!id);

  const renderSession = new StagingRenderSession();
  const ctx: StagingContext = {
    serialized,
    objectsByName,
    materials,
    manifestSlots,
    floorY: inspection.room.bounds_min[1],
    geometry,
    renderSession,
    actions,
    errors,
    state,
    strippedRoomplanIdentifiers,
  };

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        "Place chaque meuble du manifeste selon les contraintes ci-dessus, puis appelle finish_staging quand review_layout est propre.",
    },
  ];

  let finished = false;
  let previousPhase: Phase | null = null;
  const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: systemPrompt(inspection, kept, buildPromptZones(geometry), buildPromptManifest(manifestSlotsFlat, dimensionsByItemNo)),
      cache_control: { type: "ephemeral" },
    },
  ];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS && !finished; round++) {
      const phase = computePhase(manifestSlotsFlat, slotDepths, state);
      const tools = buildTools(phase, manifestSlotsFlat, slotDepths);

      if (previousPhase === null || !phasesEqual(phase, previousPhase)) {
        const notice =
          phase.kind === "depth" && phase.depth > 0
            ? `Étape suivante : place maintenant les meubles de niveau de dépendance ${phase.depth} - leurs cibles sont posées. Les slots orphelins (dont la cible a échoué) ont été abandonnés automatiquement.`
            : phase.kind === "cleanup"
              ? "Tous les slots du manifeste sont traités (placés ou abandonnés). Passe à review_layout, corrige avec adjust_placement si besoin, puis finish_staging."
              : null;
        if (notice && previousPhase !== null) {
          messages.push({ role: "user", content: [{ type: "text", text: notice }] });
        }
        previousPhase = phase;
      }

      const response = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        // 8192 was too tight: adaptive thinking (on by default) plus a real
        // tool_use call (a PlacementIntent's nested schema is verbose) can
        // exceed it before Claude ever finishes a turn.
        max_tokens: 16000,
        // Default effort is "high" - this task no longer needs it. Product/
        // material selection is gone (both are config-driven now) and the only
        // remaining decision per slot is picking a wall/corner/relation from a
        // small enum the manifest already constrains - a bounded, mechanical
        // choice, not the open-ended creative/spatial reasoning "high" effort
        // is meant for. Lower effort means fewer/more-consolidated tool calls
        // and less thinking-token spend per round; re-raise if a real run
        // shows it costing placement quality. Omitted entirely on models that
        // don't support it (see MODEL_SUPPORTS_EFFORT).
        ...(MODEL_SUPPORTS_EFFORT ? { output_config: { effort: "medium" as const } } : {}),
        system,
        tools,
        messages,
        // Automatically caches the growing message history's tail (the system
        // breakpoint above already covers tools+system for THIS phase) - misses
        // once per phase transition since tools' slot_id enum changes, hits
        // every other round.
        cache_control: { type: "ephemeral" },
      });

      const usage = response.usage;
      usageTotals.input += usage.input_tokens;
      usageTotals.output += usage.output_tokens;
      usageTotals.cacheRead += usage.cache_read_input_tokens ?? 0;
      usageTotals.cacheCreation += usage.cache_creation_input_tokens ?? 0;
      console.log(
        `[staging] round ${round + 1}/${MAX_TOOL_ROUNDS} (${phase}) usage: input=${usage.input_tokens} output=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens ?? 0} cache_creation=${usage.cache_creation_input_tokens ?? 0}`
      );

      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      if (toolUses.length === 0) {
        // Claude stopped without explicitly finishing — treat as done rather than looping forever.
        break;
      }

      const toolResults: Array<Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam> = [];
      for (const toolUse of toolUses) {
        const output = await callTool(toolUse.name, toolUse.input, ctx);
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: output });
        if (toolUse.name === "finish_staging" && output === "Staging finished.") finished = true;
      }

      // Round-dependent nudge goes here, NOT in the system prompt, so the
      // cached system+tools prefix stays byte-identical within a phase.
      const roundsRemaining = MAX_TOOL_ROUNDS - round - 1;
      if (roundsRemaining <= CONVERGENCE_WARNING_ROUNDS_REMAINING && roundsRemaining > 0) {
        toolResults.push({
          type: "text",
          text: `ATTENTION : il ne reste que ${roundsRemaining} tour(s) avant la limite. Termine et appelle finish_staging maintenant, quitte à laisser l'agencement imparfait plutôt que de ne rien finaliser.`,
        });
      }

      messages.push({ role: "user", content: toolResults });
    }

    console.log(
      `[staging] TOTAL usage: input=${usageTotals.input} output=${usageTotals.output} cache_read=${usageTotals.cacheRead} cache_creation=${usageTotals.cacheCreation}`
    );

    if (!finished) {
      errors.push(
        `Staging did not explicitly finish within ${MAX_TOOL_ROUNDS} tool rounds - persisting the best-effort state reached so far.`
      );
    }

    // Render once more unconditionally at the end, in case the last render/review
    // during the loop wasn't Claude's actual last action. The persisted preview is
    // always the eye-level view, never the top-down plan view Claude uses in-loop -
    // a real customer looking at the result wants a photo-like shot, not a floor plan.
    const [finalView] = await renderSession.renderPreview({
      scanData: serialized,
      actions,
      views: ["perspective"],
      strippedRoomplanIdentifiers,
    });
    const previewBuffer = finalView.buffer;

    const notesBlock = messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find(
        (block): block is Anthropic.ToolUseBlock =>
          (block as any).type === "tool_use" && (block as any).name === "finish_staging"
      ) as Anthropic.ToolUseBlock | undefined;

    const summary: StagingSummary = {
      actions,
      notes: (notesBlock?.input as any)?.notes ?? "",
      preview_render_path: null, // filled in by the caller once the render has been persisted to storage
      errors,
      stripped_roomplan_identifiers: strippedRoomplanIdentifiers,
    };

    return { summary, previewBuffer };
  } finally {
    await renderSession.close();
  }
}
