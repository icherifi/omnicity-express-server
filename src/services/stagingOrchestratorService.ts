import Anthropic from "@anthropic-ai/sdk";
import { buildRoomGeometry, inspectRoom } from "./roomShellService";
import { getMaterials } from "./materialsService";
import { StagingRenderSession } from "./stagingRenderService";
import { PlacedItem, RunState, StagingContext } from "./stagingState";
import {
  handleAdjustPlacement,
  handleFinishStaging,
  handleGetIkeaProduct,
  handlePlaceFurniture,
  handleReplaceFurniture,
  handleRenderPreview,
  handleReviewLayout,
  handleSearchIkea,
  handleSetFloorMaterial,
  handleSetWallColor,
  ToolResultContent,
} from "./stagingToolHandlers";
import { MaterialCatalog, RoomPlanCapturedRoom, SceneInspection, StagingSummary } from "../types/staging.types";

const DEFAULT_MODEL = process.env.ANTHROPIC_STAGING_MODEL || "claude-sonnet-5";
// Brought back down from an initial 35: a real run against the full multi-room
// fixture burned ~30 rounds retrying ONE or TWO items one-at-a-time (a solver
// gap - against_wall's default centering didn't avoid already-placed furniture,
// so the "best" spot was often already occupied, forcing manual offset-
// guessing) and never got to most of the apartment. That gap is now fixed
// (see placementSolverService.ts's furniture-aware free-span calculation) and
// the system prompt now pushes Claude to batch independent placements in one
// round instead of one call at a time - both should sharply cut real round
// usage for the same amount of work. 20 is a deliberately tighter budget than
// 35 to keep test iterations fast/cheap while that holds; revisit upward if a
// real multi-room run still can't finish in it.
const MAX_TOOL_ROUNDS = 20;
// With ~2 rounds left and the room still not passing review_layout clean, nudge
// Claude to converge immediately rather than silently exhausting the budget.
const CONVERGENCE_WARNING_ROUNDS_REMAINING = 2;

function anthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY environment variable");
  // A hung request here previously left a scan stuck in "processing" forever - nothing
  // ever reached the catch block in staging.ts to mark it "error". Bound it explicitly
  // rather than trust an unbounded default (10 minutes).
  //
  // Raised from 120s: the system prompt now deliberately pushes Claude to batch many
  // independent tool calls into one turn (searching/placing several items at once)
  // to cut round count - which means any one turn's generation can legitimately take
  // longer than a single-tool-call turn used to. Confirmed directly: a real run's
  // very next round (synthesizing choices for ~10 batched search results into
  // several replace_furniture calls) timed out at 120s. 240s per attempt, still
  // capped at 1 retry (worst case ~8 minutes total) rather than trusting an
  // unbounded default.
  return new Anthropic({ apiKey, timeout: 240_000, maxRetries: 1 });
}

const PLACEMENT_ANCHOR_SCHEMA = {
  type: "object",
  description:
    "Where the item goes, expressed relationally - never as raw coordinates. Exactly one of these shapes.",
  properties: {
    kind: { type: "string", enum: ["against_wall", "in_corner", "room_center", "relative_to"] },
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
    target_id: { type: "string", description: "relative_to: the instance_name/object_name of an already-placed item to position against." },
    relation: { type: "string", enum: ["left_of", "right_of", "in_front_of", "behind"], description: "relative_to only." },
    align: { type: "string", enum: ["center", "start", "end"], description: "relative_to only. Default depends on relation." },
    gap_cm: { type: "number", description: "against_wall/in_corner/relative_to: extra clearance beyond the minimum touching distance. Default 0 (5cm for relative_to)." },
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

function buildTools(materials: MaterialCatalog): Anthropic.Tool[] {
  return [
    {
      name: "search_ikea",
      description:
        "Free-text search of IKEA's live catalog (e.g. \"grey 3-seater sofa\", \"oak dining table\"). Returns candidate items with an itemNo. Always search before placing or replacing — never invent an item_no.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      name: "get_ikea_product",
      description: "Get details (price, style, product type, images) for one IKEA item_no, to help pick between search results.",
      input_schema: {
        type: "object",
        properties: { item_no: { type: "string" } },
        required: ["item_no"],
      },
    },
    {
      name: "place_furniture",
      description:
        "Download an IKEA item and place it using a placement intent (against a wall, in a corner, relative to another item, or at the room's center) - a solver turns that into exact geometry and checks it against the room (walls, doors, windows, other furniture, the real floor shape). Rejected with a specific reason if the intent doesn't resolve to a valid spot - try a different anchor or a smaller item, don't retry with raw coordinates (there's no such option). Returns the item's real-world dimensions (cm).",
      input_schema: {
        type: "object",
        properties: {
          item_no: { type: "string" },
          instance_name: { type: "string", description: "A short unique handle you choose for this item (e.g. 'nightstand_left') - reusable later as a relative_to/facing target, and to adjust_placement it." },
          intent: PLACEMENT_INTENT_SCHEMA,
        },
        required: ["item_no", "instance_name", "intent"],
      },
    },
    {
      name: "replace_furniture",
      description:
        "Swap a detected object from the scan (by object_name from the room geometry) for an IKEA item in its place. Omitting intent inherits the original object's exact position/orientation, still checked against the room - in a furnished room this frequently fails, because a differently-shaped/sized replacement collides with a NEIGHBORING original object that hasn't been touched yet (real rooms pack furniture close together). Provide an explicit intent (often relative_to the same neighbor, or against_wall for the same wall) rather than relying on the fallback. Calling this again on the same object_name replaces whatever you last put there, not the original.",
      input_schema: {
        type: "object",
        properties: {
          object_name: { type: "string" },
          item_no: { type: "string" },
          intent: PLACEMENT_INTENT_SCHEMA,
        },
        required: ["object_name", "item_no"],
      },
    },
    {
      name: "adjust_placement",
      description:
        "Re-solve the position/rotation of an item YOU already placed or replaced (by its instance_name/object_name), using a new intent - never changes which catalog item it is. Use this to fix a facing that defaulted because its target didn't exist yet, or to act on review_layout's feedback without re-picking the item.",
      input_schema: {
        type: "object",
        properties: {
          instance_name: { type: "string", description: "The instance_name (place_furniture) or object_name (replace_furniture) of an item already in the layout." },
          intent: PLACEMENT_INTENT_SCHEMA,
        },
        required: ["instance_name", "intent"],
      },
    },
    {
      name: "set_wall_color",
      description: "Paint one or more walls (by object_name from the room geometry, or \"all\") using one of the curated wall paint colors.",
      input_schema: {
        type: "object",
        properties: {
          wall_object_names: { type: "array", items: { type: "string" } },
          all_walls: { type: "boolean", description: "Set true instead of listing names to paint every wall." },
          material_id: { type: "string", enum: materials.walls.map((w) => w.material_id) },
        },
        required: ["material_id"],
      },
    },
    {
      name: "set_floor_material",
      description: "Apply one of the curated floor materials (real tileable texture, not a flat color) to the room's floor.",
      input_schema: {
        type: "object",
        properties: { material_id: { type: "string", enum: materials.floors.map((f) => f.material_id) } },
        required: ["material_id"],
      },
    },
    {
      name: "render_preview",
      description:
        "Quick ad hoc look at the room as it currently looks, from a top-down view and an eye-level view - no scoring, just pixels. SHARES A BUDGET OF 5 TOTAL CALLS WITH review_layout FOR THE WHOLE ROOM - don't call this after every single placement; place many items first, check once. Use review_layout (not this) before finish_staging.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "review_layout",
      description:
        "The real finishing-pass check: re-validates every current placement against hard constraints (wall/furniture collisions, door/window clearance, the real floor shape), computes quality scores (circulation, fill, focal-point orientation, furniture-to-room scale), and renders both camera views - everything needed to judge whether the room is actually done. Required, with zero remaining hard-constraint violations on its LATEST call, before finish_staging. Call it again after fixing anything it flags. SHARES THE SAME 5-CALL BUDGET as render_preview - the last remaining call in that budget is always reserved for this tool, never render_preview.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "finish_staging",
      description:
        "Call this once the room looks like a realistic, appealing, sellable staged scene. Rejected unless set_wall_color, set_floor_material, and a clean review_layout (no remaining hard-constraint violations) have all happened.",
      input_schema: {
        type: "object",
        properties: { notes: { type: "string", description: "Short summary of the staging choices and why." } },
        required: ["notes"],
      },
    },
  ];
}

/**
 * Deliberately fully static for the whole run (no round-dependent text) so this
 * is byte-identical on every one of up to MAX_TOOL_ROUNDS calls - the
 * precondition for prompt caching to actually hit. A single explicit
 * cache_control breakpoint on this block caches it AND every tool definition
 * (tools render before system in the request), so a 35-round run pays full
 * price for this large block (curated palettes + the whole room JSON) exactly
 * once instead of 35 times. The round-based convergence nudge moves to a plain
 * text block appended to the tool-results message instead (see runStaging) -
 * that keeps the system prompt static while Claude still sees the nudge.
 */
function systemPrompt(inspection: SceneInspection, materials: MaterialCatalog): string {
  const wallList = materials.walls.map((w) => `${w.material_id} (${w.name})`).join(", ");
  const floorList = materials.floors.map((f) => `${f.material_id} (${f.name})`).join(", ");

  return `Tu es un décorateur d'intérieur virtuel avec une liberté créative totale sur l'agencement : tu n'es pas obligé de garder le mobilier près de sa position scannée d'origine, repense l'agencement pour qu'il soit le plus vendeur possible. Tu reçois la géométrie d'une pièce scannée (murs, portes, fenêtres, sol, mobilier détecté). Ton objectif : produire une mise en scène réaliste et vendeuse ("home staging"), en utilisant exclusivement le catalogue IKEA (recherche live via search_ikea).

Contrairement à une position libre en coordonnées, tu places chaque meuble via une INTENTION relationnelle (contre quel mur, à côté de quel autre meuble, orienté vers quoi) — un solveur calcule la géométrie exacte et vérifie automatiquement les collisions, le dégagement des portes/fenêtres, et les limites réelles du sol. Ce n'est pas une contrainte technique à contourner : c'est ce qui te permet de raisonner comme un vrai décorateur ("ce fauteuil contre ce mur, orienté vers la fenêtre") plutôt que de deviner des coordonnées.

Trois étapes sont OBLIGATOIRES et vérifiées automatiquement — finish_staging est refusé tant qu'elles n'ont pas toutes eu lieu : set_wall_color, set_floor_material, et un review_layout dont le DERNIER appel ne signale plus aucune violation de contrainte dure.

Contraintes de budget IMPORTANTES — lis-les avant de commencer :
- Tu disposes d'environ ${MAX_TOOL_ROUNDS} tours d'outils pour TOUTE la pièce (pas par meuble). Un tour peut contenir PLUSIEURS appels d'outils indépendants à la fois — utilise cette possibilité systématiquement : dès que plusieurs meubles n'ont AUCUNE dépendance entre eux (pas de relative_to les uns envers les autres), lance leurs replace_furniture/place_furniture dans le MÊME tour plutôt qu'un par un. Traiter les meubles un par un et attendre le résultat de chacun avant de passer au suivant est ce qui épuise le budget avant d'avoir couvert toute la pièce.
- render_preview et review_layout partagent un budget total de 5 appels pour toute la pièce (pas par meuble) — n'appelle PAS ces outils après chaque placement individuel. Place un maximum de meubles d'abord (idéalement pièce par pièce), puis vérifie visuellement. Garde toujours au moins 1 appel en réserve pour le review_layout final obligatoire.
- Si un meuble résiste après 2-3 tentatives infructueuses, laisse-le de côté et passe aux autres meubles/pièces — tu pourras y revenir avec adjust_placement/replace_furniture s'il te reste du budget, mais ne bloque jamais toute la pièce sur un seul objet difficile.

Règles :
- Pour chaque meuble déjà détecté dans le scan, décide de le REMPLACER par un meuble IKEA de type/dimensions proches (replace_furniture), sauf s'il n'a pas d'équivalent pertinent (ex. baignoire, toilettes, four, plaques, évier, réfrigérateur : ce sont des équipements fixes, pas du mobilier — ne cherche pas à les remplacer, ils resteront visibles tels quels dans le rendu).
- IMPORTANT : fournis presque toujours un intent explicite à replace_furniture, ne compte pas sur l'héritage automatique de la position d'origine — dans une pièce meublée, un article de remplacement (forcément d'une taille différente de l'original) entre très souvent en collision avec un objet VOISIN pas encore remplacé, puisque les meubles d'origine sont scannés serrés les uns contre les autres. Si un appel échoue pour cette raison, réessaie tout de suite avec un intent (souvent relative_to ce même voisin, ou against_wall sur le même mur) plutôt que de passer au meuble suivant.
- Intention de placement : against_wall (contre un mur, centré sur le plus grand espace libre par défaut), in_corner (dans un angle, entre deux murs), relative_to (à gauche/droite/devant/derrière un autre meuble déjà placé, par son instance_name/object_name), ou room_center. L'orientation (facing) a un défaut sensé selon l'ancre — précise-la seulement pour un besoin différent (ex. faire face à une fenêtre : toward_window). nudge_cm permet un petit ajustement fin (±40cm), ce n'est pas un moyen de placer librement.
- Si une intention échoue (mur inconnu, pas assez de place, cible relative_to pas encore placée), le message d'erreur explique pourquoi — essaie une autre ancre, un meuble plus petit, ou place d'abord la cible en question. Ne réessaie jamais avec des coordonnées brutes, cette option n'existe plus.
- AJOUTE aussi des meubles IKEA (place_furniture) dans toute pièce qui, après tes remplacements, resterait sans aucun mobilier — une pièce vide ne donne pas envie d'acheter.
- OBLIGATOIRE : choisis une couleur de mur (set_wall_color) et un matériau de sol (set_floor_material) parmi la liste fournie ci-dessous. Utilise all_walls: true pour peindre tous les murs d'un coup (recommandé), sauf mur d'accent volontaire — un mur non peint reste dans un blanc cassé neutre par défaut.
- Utilise review_layout (contraintes dures + scores + rendu) avant de conclure, et corrige (adjust_placement/replace_furniture) tout ce qu'il signale, puis relance-le jusqu'à ce qu'il soit propre — en respectant le budget de 5 appels partagé avec render_preview vu plus haut.
- adjust_placement corrige un meuble déjà placé (ex. une orientation qui a utilisé un repli par défaut parce que sa cible n'existait pas encore au moment du placement) sans changer l'article choisi.
- Quand les trois étapes obligatoires sont faites et que la pièce est prête, appelle finish_staging avec un résumé court des choix faits.

Couleurs de mur disponibles : ${wallList}
Matériaux de sol disponibles : ${floorList}

Géométrie de la pièce (issue du scan) :
${JSON.stringify(inspection, null, 2)}`;
}

async function callTool(name: string, input: any, ctx: StagingContext): Promise<ToolResultContent> {
  console.log(`[staging] ${name}(${JSON.stringify(input)})`);
  try {
    switch (name) {
      case "search_ikea":
        return await handleSearchIkea(input);
      case "get_ikea_product":
        return await handleGetIkeaProduct(input);
      case "place_furniture":
        return await handlePlaceFurniture(input, ctx);
      case "replace_furniture":
        return await handleReplaceFurniture(input, ctx);
      case "adjust_placement":
        return await handleAdjustPlacement(input, ctx);
      case "set_wall_color":
        return handleSetWallColor(input, ctx);
      case "set_floor_material":
        return handleSetFloorMaterial(input, ctx);
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
  const materials = getMaterials();

  const objectsByName = new Map(inspection.objects.map((o) => [o.object_name, o]));
  const tools = buildTools(materials);

  const actions: StagingContext["actions"] = [];
  const errors: string[] = [];

  const slots = new Map<string, PlacedItem>();
  for (const obj of inspection.objects) {
    const [w, h, d] = obj.dimensions_cm.map((cm) => cm / 100);
    slots.set(obj.object_name, {
      itemNo: "",
      localBox: { min: [-w / 2, -h / 2, -d / 2], max: [w / 2, h / 2, d / 2] },
      position: obj.position,
      rotationYDegrees: obj.rotation_y_degrees,
      sourceKind: "original_scan",
    });
  }

  const state: RunState = {
    hasSetWallColor: false,
    hasSetFloorMaterial: false,
    lastReviewClean: false,
    renderCallCount: 0,
    slots,
  };

  const renderSession = new StagingRenderSession();
  const ctx: StagingContext = {
    serialized,
    objectsByName,
    materials,
    floorY: inspection.room.bounds_min[1],
    geometry,
    renderSession,
    actions,
    errors,
    state,
  };

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        "Mets en scène cette pièce à l'aide des outils fournis, puis appelle finish_staging quand tu as terminé.",
    },
  ];

  let finished = false;
  // Real per-round usage, logged so a cost regression shows up immediately
  // instead of only at the bill - cache_read_input_tokens should climb toward
  // the full accumulated prefix each round once caching is actually hitting;
  // see the cumulative summary logged after the loop for the run total.
  const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

  // Cached once - byte-identical on every round (see systemPrompt's own note).
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: systemPrompt(inspection, materials), cache_control: { type: "ephemeral" } },
  ];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS && !finished; round++) {
      const response = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        // 8192 was too tight: adaptive thinking (on by default) plus a real
        // tool_use call (a PlacementIntent's nested schema is verbose) can
        // exceed it before Claude ever finishes a turn - confirmed directly by
        // a real run where round 1 alone hit exactly 8192 output tokens and
        // the loop bailed with zero completed tool calls, having done nothing.
        max_tokens: 16000,
        system,
        tools,
        messages,
        // Automatically caches the growing message history's tail (the system
        // breakpoint above already covers tools+system) - the "robust
        // combination for agent loops": one explicit breakpoint on the static
        // prefix, automatic caching for everything volatile after it.
        cache_control: { type: "ephemeral" },
      });

      const usage = response.usage;
      usageTotals.input += usage.input_tokens;
      usageTotals.output += usage.output_tokens;
      usageTotals.cacheRead += usage.cache_read_input_tokens ?? 0;
      usageTotals.cacheCreation += usage.cache_creation_input_tokens ?? 0;
      console.log(
        `[staging] round ${round + 1}/${MAX_TOOL_ROUNDS} usage: input=${usage.input_tokens} output=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens ?? 0} cache_creation=${usage.cache_creation_input_tokens ?? 0}`
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
      // cached system+tools prefix stays byte-identical for the whole run.
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
    // always the eye-level view, never the top-down plan view.
    const finalViews = await renderSession.renderPreview({ scanData: serialized, actions });
    const previewBuffer = finalViews.find((v) => v.key === "perspective")?.buffer ?? finalViews[0].buffer;

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
    };

    return { summary, previewBuffer };
  } finally {
    await renderSession.close();
  }
}
