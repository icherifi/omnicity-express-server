import Anthropic from "@anthropic-ai/sdk";
import * as ikeaService from "./ikeaService";
import * as glbGeometryService from "./glbGeometryService";
import { LocalBoundingBox } from "./glbGeometryService";
import { buildWallCollisionBoxes, inspectRoom, wallClipVolume, WallBox } from "./roomShellService";
import { getMaterials } from "./materialsService";
import { StagingRenderSession } from "./stagingRenderService";
import {
  DetectedObject,
  MaterialCatalog,
  RoomPlanCapturedRoom,
  SceneInspection,
  StagingAction,
  StagingSummary,
} from "../types/staging.types";

const DEFAULT_MODEL = process.env.ANTHROPIC_STAGING_MODEL || "claude-sonnet-5";
const MAX_TOOL_ROUNDS = 25;
const OVERLAP_VOLUME_THRESHOLD_M3 = 0.01;
const WALL_OVERLAP_VOLUME_THRESHOLD_M3 = 0.01;

function anthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY environment variable");
  // A hung request here previously left a scan stuck in "processing" forever - nothing
  // ever reached the catch block in staging.ts to mark it "error". Bound it explicitly
  // rather than trust an unbounded default (10 minutes).
  //
  // The SDK retries a timed-out request by default (maxRetries: 2), so the real
  // worst case is timeout * (1 + maxRetries) - with the default retry count that's
  // 6 minutes, not 120s, which is exactly how long a real stalled run took to
  // (correctly) surface as an error. Capping retries at 1 keeps some resilience to a
  // one-off network blip without compounding the wait past ~4 minutes.
  return new Anthropic({ apiKey, timeout: 120_000, maxRetries: 1 });
}

function buildTools(materials: MaterialCatalog): Anthropic.Tool[] {
  return [
    {
      name: "search_ikea",
      description:
        "Free-text search of IKEA's live catalog (e.g. \"grey 3-seater sofa\", \"oak dining table\"). Returns candidate items with an itemNo. Always search before placing or replacing — never invent an item_no.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_ikea_product",
      description: "Get details (price, style, product type, images) for one IKEA item_no, to help pick between search results.",
      input_schema: {
        type: "object",
        properties: {
          item_no: { type: "string" },
        },
        required: ["item_no"],
      },
    },
    {
      name: "place_furniture",
      description:
        "Download an IKEA item and place it in an empty area of the room. Returns the item's real-world dimensions (cm) so you can check it actually fits, any furniture it now overlaps, and any wall it clips through.",
      input_schema: {
        type: "object",
        properties: {
          item_no: { type: "string" },
          position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          rotation_y_degrees: { type: "number" },
        },
        required: ["item_no", "position", "rotation_y_degrees"],
      },
    },
    {
      name: "replace_furniture",
      description:
        "Swap a detected object from the scan (by object_name from the room inspection) for an IKEA item in its place. Position/rotation default to the original object's transform if omitted. Returns the new object's real-world dimensions (cm), any furniture it now overlaps, and any wall it clips through. Calling this again on the same object_name replaces whatever you last put there, not the original.",
      input_schema: {
        type: "object",
        properties: {
          object_name: { type: "string" },
          item_no: { type: "string" },
          position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          rotation_y_degrees: { type: "number" },
        },
        required: ["object_name", "item_no"],
      },
    },
    {
      name: "set_wall_color",
      description: "Paint one or more walls (by object_name from the room inspection, or \"all\") using one of the curated wall paint colors.",
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
        properties: {
          material_id: { type: "string", enum: materials.floors.map((f) => f.material_id) },
        },
        required: ["material_id"],
      },
    },
    {
      name: "render_preview",
      description:
        "Render the room as it currently looks and see it from two angles: a top-down plan view (best for spotting overlaps, clipping, and empty/cramped areas) and an eye-level view (best for style, colors, realism), plus a full collision report (furniture-vs-furniture and furniture-vs-wall). Use this to visually check your work — things the per-item dimensions/overlap numbers alone won't tell you. Required at least once before finish_staging.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "finish_staging",
      description:
        "Call this once the room looks like a realistic, appealing, sellable staged scene. Rejected if you haven't called render_preview at least once — look at the room before declaring it done.",
      input_schema: {
        type: "object",
        properties: {
          notes: { type: "string", description: "Short summary of the staging choices and why." },
        },
        required: ["notes"],
      },
    },
  ];
}

function systemPrompt(inspection: SceneInspection, materials: MaterialCatalog): string {
  const wallList = materials.walls.map((w) => `${w.material_id} (${w.name})`).join(", ");
  const floorList = materials.floors.map((f) => `${f.material_id} (${f.name})`).join(", ");

  return `Tu es un décorateur d'intérieur virtuel. Tu reçois la géométrie d'une pièce scannée, avec des objets déjà détectés (murs, sol, et du mobilier). Ton objectif : produire une mise en scène réaliste et vendeuse ("home staging"), en utilisant exclusivement le catalogue IKEA (recherche live via search_ikea).

Trois étapes sont OBLIGATOIRES et vérifiées automatiquement — finish_staging est refusé tant que les trois n'ont pas été faites au moins une fois, quel que soit le reste : set_wall_color, set_floor_material, et render_preview (dans cet ordre ou un autre, mais toutes les trois).

Règles :
- Pour chaque meuble déjà détecté dans le scan, décide de le REMPLACER par un meuble IKEA de type/dimensions proches (replace_furniture), sauf s'il n'a pas d'équivalent pertinent (ex. baignoire, toilettes, four, plaques : ce sont des équipements fixes, pas du mobilier — ne cherche pas à les remplacer).
- AJOUTE aussi des meubles IKEA (place_furniture) dans toute pièce qui, après tes remplacements, resterait sans aucun mobilier — une pièce vide ne donne pas envie d'acheter. Regarde le render pour repérer ces zones.
- OBLIGATOIRE : choisis une couleur de mur (set_wall_color) et un matériau de sol (set_floor_material) parmi la liste fournie ci-dessous — ne saute pas cette étape, elle est vérifiée. Utilise all_walls: true pour peindre tous les murs d'un coup (recommandé), sauf si tu veux volontairement un mur d'accent différent — un mur non peint reste dans un blanc cassé neutre par défaut, ce n'est jamais une erreur bloquante mais un choix de couleur cohérent sur toute la pièce est plus vendeur.
- Après chaque place_furniture/replace_furniture, vérifie les dimensions réelles renvoyées (dimensions_cm) : si l'objet est manifestement trop grand/petit pour l'espace, cherche une meilleure alternative.
- Recherche toujours avec search_ikea avant de placer ou remplacer — n'invente jamais d'item_no.
- Les positions sont en mètres, dans le repère de la pièce fourni ci-dessous (Y = axe vertical). Le Y d'une position est le niveau du sol où l'objet doit reposer (le bas de l'objet — quelle que soit son origine 3D propre — sera aligné automatiquement sur ce Y) ; utilise le sol de la pièce (voir bounds_min ci-dessous) sauf pour un meuble volontairement suspendu/mural. Les rotations (rotation_y_degrees) sont en degrés autour de l'axe Y.
- Un avertissement de chevauchement (warning/overlapping_object_names) après place_furniture/replace_furniture ne veut pas forcément dire une erreur (un objet peut légitimement en toucher un autre, ex. une lampe sur une table) — mais vérifie que ce n'est pas une vraie collision. wall_overlap_object_names signale en plus un meuble qui traverse un mur — dans ce cas, déplace-le ou fais-le pivoter, ce n'est jamais légitime.
- OBLIGATOIRE : appelle render_preview au moins une fois pour regarder le résultat avant de conclure — il te renvoie une vue du dessus (idéale pour repérer chevauchements, meubles qui débordent, zones vides ou trop denses) ET une vue à hauteur d'œil (idéale pour le style/les couleurs/le réalisme), plus un rapport de collision complet. Si un meuble a l'air mal orienté ou traverse un mur, corrige position/rotation_y_degrees et relance replace_furniture/place_furniture sur ce même meuble.
- Quand les trois étapes obligatoires sont faites et que la pièce est prête, appelle finish_staging avec un résumé court des choix faits.

Couleurs de mur disponibles : ${wallList}
Matériaux de sol disponibles : ${floorList}

Géométrie de la pièce (issue du scan) :
${JSON.stringify(inspection, null, 2)}`;
}

type ToolResultContent = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>;

interface PlacedItem {
  itemNo: string;
  /** The model's own as-authored bounding box, before placement - empty/zeroed for
   * original scanned objects (reconstructed from dimensions_cm instead). */
  localBox: LocalBoundingBox;
  position: [number, number, number];
  rotationYDegrees: number;
}

interface RunState {
  hasRenderedPreview: boolean;
  hasSetWallColor: boolean;
  hasSetFloorMaterial: boolean;
  /**
   * What CURRENTLY occupies each slot, keyed by the original scanned object's
   * object_name for replace_furniture targets, or a synthetic "PlacedN" key for
   * bare place_furniture calls. Seeded at startup with one entry per original
   * RoomPlan furniture object, so overlap checks always scan one uniform
   * collection. Replacing a slot is just overwriting its map entry - there's no
   * scene file to delete anything from anymore, so (unlike the old Blender
   * bridge) a second replace of the same slot needs no special-case handling.
   */
  slots: Map<string, PlacedItem>;
  nextPlacedIndex: number;
}

interface StagingContext {
  serialized: RoomPlanCapturedRoom;
  objectsByName: Map<string, DetectedObject>;
  materials: MaterialCatalog;
  /** Room's floor height (bounds_min[1]) - the default Y for replace_furniture
   * when Claude doesn't override it. */
  floorY: number;
  /** One outward-padded collision box per wall - walls never move during a run,
   * computed once at startup. */
  wallBoxes: WallBox[];
  renderSession: StagingRenderSession;
  actions: StagingAction[];
  errors: string[];
  state: RunState;
}

function findOverlaps(slots: Map<string, PlacedItem>, excludeKey: string | null, placedBox: LocalBoundingBox): string[] {
  const overlapping: string[] = [];
  for (const [key, item] of slots) {
    if (key === excludeKey) continue;
    const otherBox = glbGeometryService.placedBoundingBox(item.localBox, item.position, item.rotationYDegrees);
    const volume = glbGeometryService.boxOverlapVolume(placedBox, otherBox);
    if (volume > OVERLAP_VOLUME_THRESHOLD_M3) overlapping.push(key);
  }
  return overlapping;
}

/** Doors/windows/openings are deliberately NOT obstacles here - the wall's full
 * un-cut box is the test volume, so a furniture piece placed in a doorway shows up
 * as a wall clip too (a useful side effect, not a separate check). */
function findWallClips(
  wallBoxes: WallBox[],
  localBox: LocalBoundingBox,
  position: [number, number, number],
  rotationYDegrees: number
): string[] {
  return wallBoxes
    .filter((wall) => wallClipVolume(wall, localBox, position, rotationYDegrees) > WALL_OVERLAP_VOLUME_THRESHOLD_M3)
    .map((w) => w.object_name);
}

function collisionWarning(furnitureOverlaps: string[], wallClips: string[]): string | undefined {
  const parts: string[] = [];
  if (furnitureOverlaps.length > 0) {
    parts.push(`overlaps ${furnitureOverlaps.join(", ")} — check if intentional (e.g. stacking) or move/replace it`);
  }
  if (wallClips.length > 0) {
    parts.push(`clips through ${wallClips.join(", ")} — move it away from the wall or rotate it`);
  }
  return parts.length > 0 ? parts.join("; ") + "." : undefined;
}

/** Every current overlap in the room - furniture-vs-furniture AND furniture-vs-wall
 * - swept in one pass over the same slots/wallBoxes used per-call above. Cheap even
 * called every render_preview (a handful of items x a few dozen walls). */
function buildCollisionReport(state: RunState, wallBoxes: WallBox[]): string {
  const lines: string[] = [];
  const keys = [...state.slots.keys()];
  for (let i = 0; i < keys.length; i++) {
    const itemA = state.slots.get(keys[i])!;
    const boxA = glbGeometryService.placedBoundingBox(itemA.localBox, itemA.position, itemA.rotationYDegrees);
    for (let j = i + 1; j < keys.length; j++) {
      const itemB = state.slots.get(keys[j])!;
      const boxB = glbGeometryService.placedBoundingBox(itemB.localBox, itemB.position, itemB.rotationYDegrees);
      if (glbGeometryService.boxOverlapVolume(boxA, boxB) > OVERLAP_VOLUME_THRESHOLD_M3) {
        lines.push(`- ${keys[i]} overlaps ${keys[j]}`);
      }
    }
    for (const wall of wallBoxes) {
      if (wallClipVolume(wall, itemA.localBox, itemA.position, itemA.rotationYDegrees) > WALL_OVERLAP_VOLUME_THRESHOLD_M3) {
        lines.push(`- ${keys[i]} clips through wall ${wall.object_name}`);
      }
    }
  }
  return lines.length > 0 ? `Collision report:\n${lines.join("\n")}` : "Collision report: no collisions detected.";
}

async function callTool(name: string, input: any, ctx: StagingContext): Promise<ToolResultContent> {
  console.log(`[staging] ${name}(${JSON.stringify(input)})`);
  const { objectsByName, materials, actions, errors, state } = ctx;
  try {
    switch (name) {
      case "search_ikea": {
        const results = await ikeaService.search(input.query);
        return JSON.stringify(results);
      }

      case "get_ikea_product": {
        const product = await ikeaService.getProduct(input.item_no);
        return JSON.stringify(product);
      }

      case "place_furniture": {
        const position: [number, number, number] = input.position;
        const rotationYDegrees = input.rotation_y_degrees;

        const glbPath = await ikeaService.getModel(input.item_no);
        const localBox = glbGeometryService.computeLocalBoundingBox(glbPath);
        const dimensions_cm = glbGeometryService.dimensionsCm(localBox);
        const placedBox = glbGeometryService.placedBoundingBox(localBox, position, rotationYDegrees);
        const overlapping = findOverlaps(state.slots, null, placedBox);
        const wallClips = findWallClips(ctx.wallBoxes, localBox, position, rotationYDegrees);

        const slotKey = `Placed${state.nextPlacedIndex++}`;
        state.slots.set(slotKey, { itemNo: input.item_no, localBox, position, rotationYDegrees });

        actions.push({ type: "place", item_no: input.item_no, position, rotation_y_degrees: rotationYDegrees });
        return JSON.stringify({
          dimensions_cm,
          overlapping_object_names: overlapping,
          wall_overlap_object_names: wallClips,
          warning: collisionWarning(overlapping, wallClips),
        });
      }

      case "replace_furniture": {
        const original = objectsByName.get(input.object_name);
        if (!original) return `ERROR: unknown object_name ${input.object_name} (not in room inspection)`;

        // original.position's Y is that scanned object's own center - reusing it
        // directly as a new, usually differently-sized item's placement floated
        // replacements roughly half their height above the real floor. X/Z
        // (footprint location) are still fine to inherit; Y should come from the
        // room's actual floor level instead.
        const position: [number, number, number] = input.position ?? [
          original.position[0],
          ctx.floorY,
          original.position[2],
        ];
        const rotationYDegrees = input.rotation_y_degrees ?? original.rotation_y_degrees;

        const glbPath = await ikeaService.getModel(input.item_no);
        const localBox = glbGeometryService.computeLocalBoundingBox(glbPath);
        const dimensions_cm = glbGeometryService.dimensionsCm(localBox);
        const placedBox = glbGeometryService.placedBoundingBox(localBox, position, rotationYDegrees);
        const overlapping = findOverlaps(state.slots, input.object_name, placedBox);
        const wallClips = findWallClips(ctx.wallBoxes, localBox, position, rotationYDegrees);

        state.slots.set(input.object_name, { itemNo: input.item_no, localBox, position, rotationYDegrees });

        actions.push({
          type: "replace",
          object_name: input.object_name,
          replaces_roomplan_identifier: original.roomplan_identifier,
          item_no: input.item_no,
          position,
          rotation_y_degrees: rotationYDegrees,
        });
        return JSON.stringify({
          dimensions_cm,
          overlapping_object_names: overlapping,
          wall_overlap_object_names: wallClips,
          warning: collisionWarning(overlapping, wallClips),
        });
      }

      case "set_wall_color": {
        const material = materials.walls.find((w) => w.material_id === input.material_id);
        if (!material) return `ERROR: unknown wall material_id ${input.material_id}`;

        const targets: string[] = input.wall_object_names ?? [];
        state.hasSetWallColor = true;
        actions.push({
          type: "wall_color",
          wall_object_names: input.all_walls ? "all" : targets,
          material_id: material.material_id,
          hex_color: material.hex_color,
        });
        return `Wall color set to ${material.name}.`;
      }

      case "set_floor_material": {
        const material = materials.floors.find((f) => f.material_id === input.material_id);
        if (!material) return `ERROR: unknown floor material_id ${input.material_id}`;

        state.hasSetFloorMaterial = true;
        actions.push({
          type: "floor_material",
          material_id: material.material_id,
          diffuse_path: material.diffuse_path,
          normal_path: material.normal_path,
          roughness_path: material.roughness_path,
          tile_size_cm: material.tile_size_cm,
        });
        return `Floor material set to ${material.name}.`;
      }

      case "render_preview": {
        const views = await ctx.renderSession.renderPreview({ scanData: ctx.serialized, actions });
        state.hasRenderedPreview = true;

        const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [
          { type: "text", text: buildCollisionReport(state, ctx.wallBoxes) },
        ];
        for (const view of views) {
          content.push({
            type: "text",
            text:
              view.key === "top-down"
                ? "Top-down plan view — check spacing, overlaps, clearances, traffic flow:"
                : "Eye-level view — check style, colors, realism:",
          });
          content.push({
            type: "image",
            source: { type: "base64", media_type: "image/png", data: view.buffer.toString("base64") },
          });
        }
        return content;
      }

      case "finish_staging": {
        const missing: string[] = [];
        if (!state.hasSetWallColor) missing.push("set_wall_color");
        if (!state.hasSetFloorMaterial) missing.push("set_floor_material");
        if (!state.hasRenderedPreview) missing.push("render_preview");
        if (missing.length > 0) {
          return `ERROR: call ${missing.join(" and ")} before finishing — ${
            state.hasRenderedPreview ? "" : "look at the result, and "
          }a staged room needs walls and floor addressed, not just furniture.`;
        }
        return "Staging finished.";
      }

      default:
        return `ERROR: unknown tool ${name}`;
    }
  } catch (e: any) {
    const message = e?.message ?? String(e);
    errors.push(message);
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
  const materials = getMaterials();

  const objectsByName = new Map(inspection.objects.map((o) => [o.object_name, o]));
  const tools = buildTools(materials);

  const actions: StagingAction[] = [];
  const errors: string[] = [];

  const slots = new Map<string, PlacedItem>();
  for (const obj of inspection.objects) {
    const [w, h, d] = obj.dimensions_cm.map((cm) => cm / 100);
    slots.set(obj.object_name, {
      itemNo: "",
      localBox: { min: [-w / 2, -h / 2, -d / 2], max: [w / 2, h / 2, d / 2] },
      position: obj.position,
      rotationYDegrees: obj.rotation_y_degrees,
    });
  }

  const state: RunState = {
    hasRenderedPreview: false,
    hasSetWallColor: false,
    hasSetFloorMaterial: false,
    slots,
    nextPlacedIndex: 0,
  };

  const renderSession = new StagingRenderSession();
  const ctx: StagingContext = {
    serialized,
    objectsByName,
    materials,
    floorY: inspection.room.bounds_min[1],
    wallBoxes: buildWallCollisionBoxes(serialized.walls, inspection.room),
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

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS && !finished; round++) {
      const response = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 8192,
        system: systemPrompt(inspection, materials),
        tools,
        messages,
      });

      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      if (toolUses.length === 0) {
        // Claude stopped without explicitly finishing — treat as done rather than looping forever.
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const output = await callTool(toolUse.name, toolUse.input, ctx);
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: output });
        if (toolUse.name === "finish_staging" && output === "Staging finished.") finished = true;
      }

      messages.push({ role: "user", content: toolResults });
    }

    // Render once more unconditionally at the end, in case the last render_preview
    // during the loop wasn't Claude's actual last action (it can set more wall/floor
    // materials after looking, without re-rendering before finish_staging). The
    // persisted preview is always the eye-level view, never the top-down plan view.
    const finalViews = await renderSession.renderPreview({ scanData: serialized, actions });
    const previewBuffer =
      finalViews.find((v) => v.key === "perspective")?.buffer ?? finalViews[0].buffer;

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
