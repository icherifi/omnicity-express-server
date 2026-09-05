import Anthropic from "@anthropic-ai/sdk";
import * as bridge from "./blenderBridgeService";
import {
  DetectedObject,
  FloorMaterial,
  MaterialCatalog,
  RoomPlanCapturedRoom,
  SceneInspection,
  StagingAction,
  StagingSummary,
} from "../types/staging.types";

const DEFAULT_MODEL = process.env.ANTHROPIC_STAGING_MODEL || "claude-sonnet-5";
const MAX_TOOL_ROUNDS = 25;

function anthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY environment variable");
  return new Anthropic({ apiKey });
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
        "Download and import an IKEA item into an empty area of the room. Returns the imported object's real-world dimensions (cm) so you can check it actually fits — undo by deleting the returned object names via set_wall_color-style scripting is not available, so pick carefully or replace with a better-fitting item afterwards.",
      input_schema: {
        type: "object",
        properties: {
          item_no: { type: "string" },
          position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          rotation_z_degrees: { type: "number" },
        },
        required: ["item_no", "position", "rotation_z_degrees"],
      },
    },
    {
      name: "replace_furniture",
      description:
        "Remove a detected object from the scan (by object_name from the room inspection) and put an IKEA item in its place. Position/rotation default to the original object's transform if omitted. Returns the new object's real-world dimensions (cm).",
      input_schema: {
        type: "object",
        properties: {
          object_name: { type: "string" },
          item_no: { type: "string" },
          position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          rotation_z_degrees: { type: "number" },
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
        "Render the room as it currently looks and see the image. Use this to visually check your work — a chair clipping through a wall, colors that clash, an obviously empty-looking room — things the dimensions/overlap numbers alone won't tell you. Required at least once before finish_staging.",
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

  return `Tu es un décorateur d'intérieur virtuel. Tu reçois le scan 3D (USDZ) d'une pièce déjà importé dans Blender, avec des objets déjà détectés (murs, sol, et du mobilier placé par le scan). Ton objectif : produire une mise en scène réaliste et vendeuse ("home staging"), en utilisant exclusivement le catalogue IKEA (recherche live via search_ikea).

Trois étapes sont OBLIGATOIRES et vérifiées automatiquement — finish_staging est refusé tant que les trois n'ont pas été faites au moins une fois, quel que soit le reste : set_wall_color, set_floor_material, et render_preview (dans cet ordre ou un autre, mais toutes les trois).

Règles :
- Pour chaque meuble déjà détecté dans le scan, décide de le REMPLACER par un meuble IKEA de type/dimensions proches (replace_furniture), sauf s'il n'a pas d'équivalent pertinent (ex. baignoire, toilettes, four, plaques : ce sont des équipements fixes, pas du mobilier — ne cherche pas à les remplacer).
- AJOUTE aussi des meubles IKEA (place_furniture) dans toute pièce qui, après tes remplacements, resterait sans aucun mobilier — une pièce vide ne donne pas envie d'acheter. Regarde le render pour repérer ces zones.
- OBLIGATOIRE : choisis une couleur de mur (set_wall_color) et un matériau de sol (set_floor_material) parmi la liste fournie ci-dessous — ne saute pas cette étape, elle est vérifiée.
- Après chaque place_furniture/replace_furniture, vérifie les dimensions réelles renvoyées (dimensions_cm) : si l'objet est manifestement trop grand/petit pour l'espace, cherche une meilleure alternative.
- Recherche toujours avec search_ikea avant de placer ou remplacer — n'invente jamais d'item_no.
- Les positions sont en mètres, dans le repère de la pièce fourni ci-dessous. Les rotations sont en degrés autour de l'axe Z.
- Un avertissement de chevauchement (warning/overlapping_object_names) après place_furniture/replace_furniture ne veut pas forcément dire une erreur (un objet peut légitimement en toucher un autre, ex. une lampe sur une table) — mais vérifie que ce n'est pas une vraie collision.
- OBLIGATOIRE : appelle render_preview au moins une fois pour regarder le résultat avant de conclure — les chiffres (dimensions, chevauchements) ne disent pas tout : un meuble qui traverse un mur, des couleurs qui jurent, une pièce qui a l'air vide ne se voient qu'à l'image.
- Quand les trois étapes obligatoires sont faites et que la pièce est prête, appelle finish_staging avec un résumé court des choix faits.

Couleurs de mur disponibles : ${wallList}
Matériaux de sol disponibles : ${floorList}

Géométrie de la pièce (issue du scan) :
${JSON.stringify(inspection, null, 2)}`;
}

type ToolResultContent = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>;

interface RunState {
  hasRenderedPreview: boolean;
  hasSetWallColor: boolean;
  hasSetFloorMaterial: boolean;
  /**
   * What CURRENTLY occupies each original-scan-object slot, keyed by that slot's
   * original name. Starts as each slot occupied by itself; after a replace, updated to
   * that import's own object_names — so a second replace of the same slot deletes the
   * PREVIOUS IKEA item instead of futilely searching for the long-gone original name
   * (that bug shipped once already: a re-replaced sofa just piled a second one on top).
   */
  currentOccupants: Map<string, string[]>;
}

async function callTool(
  sessionId: string,
  name: string,
  input: any,
  objectsByName: Map<string, DetectedObject>,
  materials: MaterialCatalog,
  actions: StagingAction[],
  errors: string[],
  state: RunState
): Promise<ToolResultContent> {
  console.log(`[staging] ${name}(${JSON.stringify(input)})`);
  try {
    switch (name) {
      case "search_ikea": {
        const results = await bridge.searchIkea(input.query);
        return JSON.stringify(results);
      }

      case "get_ikea_product": {
        const product = await bridge.getIkeaProduct(input.item_no);
        return JSON.stringify(product);
      }

      case "place_furniture": {
        const [x, y, z] = input.position;
        const result = await bridge.placeOrReplaceIkeaItem(sessionId, {
          itemNo: input.item_no,
          position: [x, y, z],
          rotationZDegrees: input.rotation_z_degrees,
        });
        if (!result.success) {
          errors.push(result.output);
          return `ERROR: ${result.output}`;
        }

        actions.push({
          type: "place",
          item_no: input.item_no,
          position: [x, y, z],
          rotation_z_degrees: input.rotation_z_degrees,
        });
        return JSON.stringify({
          object_names: result.object_names,
          dimensions_cm: result.dimensions_cm,
          overlapping_object_names: result.overlapping_object_names,
          warning:
            result.overlapping_object_names.length > 0
              ? `Overlaps ${result.overlapping_object_names.join(", ")} — check if intentional (e.g. stacking) or move/replace it.`
              : undefined,
        });
      }

      case "replace_furniture": {
        const original = objectsByName.get(input.object_name);
        if (!original) return `ERROR: unknown object_name ${input.object_name} (not in room inspection)`;

        const position = input.position ?? original.position;
        const rotation = input.rotation_z_degrees ?? original.rotation_z_degrees;
        const occupantNames = state.currentOccupants.get(input.object_name) ?? [input.object_name];

        const result = await bridge.placeOrReplaceIkeaItem(sessionId, {
          itemNo: input.item_no,
          position,
          rotationZDegrees: rotation,
          replaceObjectNames: occupantNames,
        });
        if (!result.success) {
          errors.push(result.output);
          return `ERROR: ${result.output}`;
        }

        state.currentOccupants.set(input.object_name, result.object_names);

        actions.push({
          type: "replace",
          object_name: input.object_name,
          replaces_roomplan_identifier: original.roomplan_identifier,
          item_no: input.item_no,
          position,
          rotation_z_degrees: rotation,
        });
        return JSON.stringify({
          object_names: result.object_names,
          dimensions_cm: result.dimensions_cm,
          overlapping_object_names: result.overlapping_object_names,
          warning:
            result.overlapping_object_names.length > 0
              ? `Overlaps ${result.overlapping_object_names.join(", ")} — check if intentional (e.g. stacking) or move/replace it.`
              : undefined,
        });
      }

      case "set_wall_color": {
        const material = materials.walls.find((w) => w.material_id === input.material_id);
        if (!material) return `ERROR: unknown wall material_id ${input.material_id}`;

        const targets: string[] = input.wall_object_names ?? [];
        const script = buildWallColorScript(input.all_walls ? "all" : targets, material.hex_color);
        const result = await bridge.executeScript(sessionId, script);
        if (!result.success) {
          errors.push(result.output);
          return `ERROR: ${result.output}`;
        }

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

        const script = buildFloorMaterialScript(material);
        const result = await bridge.executeScript(sessionId, script);
        if (!result.success) {
          errors.push(result.output);
          return `ERROR: ${result.output}`;
        }

        state.hasSetFloorMaterial = true;
        actions.push({ type: "floor_material", material_id: material.material_id });
        return `Floor material set to ${material.name}.`;
      }

      case "render_preview": {
        const preview = await bridge.renderPreview(sessionId);
        const { buffer } = await bridge.downloadBridgeFile(preview.file_url);
        state.hasRenderedPreview = true;
        return [
          { type: "text", text: "Current state of the room:" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: buffer.toString("base64") } },
        ];
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

export function buildWallColorScript(targets: string[] | "all", hexColor: string): string {
  const [r, g, b] = hexToLinearRgb(hexColor);
  const targetsExpr =
    targets === "all"
      ? "[o for o in bpy.data.objects if o.type == 'MESH' and 'wall' in o.name.lower()]"
      : `[bpy.data.objects.get(n) for n in ${JSON.stringify(targets)}]`;
  return `
targets = ${targetsExpr}
for obj in targets:
    if obj is None or obj.type != 'MESH':
        continue
    mat = bpy.data.materials.get(f"staging_wall_{obj.name}") or bpy.data.materials.new(f"staging_wall_{obj.name}")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (${r}, ${g}, ${b}, 1.0)
    obj.data.materials.clear()
    obj.data.materials.append(mat)
`;
}

/**
 * Builds a real PBR material (diffuse/normal/roughness maps, tiled at the material's
 * real-world tile_size_cm via a Mapping node) instead of a flat color — flat floors
 * don't read as realistic in a staging render the way flat-painted walls do.
 */
export function buildFloorMaterialScript(floor: FloorMaterial): string {
  const tileWidthM = floor.tile_size_cm[0] / 100;
  const tileHeightM = floor.tile_size_cm[1] / 100;
  return `
floor_objs = [o for o in bpy.data.objects if o.type == 'MESH' and 'floor' in o.name.lower()]

for obj in floor_objs:
    mat = bpy.data.materials.get(f"staging_floor_{obj.name}") or bpy.data.materials.new(f"staging_floor_{obj.name}")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    output = nodes.new("ShaderNodeOutputMaterial")
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])

    tex_coord = nodes.new("ShaderNodeTexCoord")
    mapping = nodes.new("ShaderNodeMapping")
    links.new(tex_coord.outputs["Generated"], mapping.inputs["Vector"])
    repeat_x = max(obj.dimensions.x / ${tileWidthM}, 0.01)
    repeat_y = max(obj.dimensions.y / ${tileHeightM}, 0.01)
    mapping.inputs["Scale"].default_value = (repeat_x, repeat_y, 1.0)

    diffuse_tex = nodes.new("ShaderNodeTexImage")
    diffuse_tex.image = bpy.data.images.load(${JSON.stringify(floor.diffuse_path)}, check_existing=True)
    links.new(mapping.outputs["Vector"], diffuse_tex.inputs["Vector"])
    links.new(diffuse_tex.outputs["Color"], bsdf.inputs["Base Color"])

    rough_tex = nodes.new("ShaderNodeTexImage")
    rough_tex.image = bpy.data.images.load(${JSON.stringify(floor.roughness_path)}, check_existing=True)
    rough_tex.image.colorspace_settings.name = 'Non-Color'
    links.new(mapping.outputs["Vector"], rough_tex.inputs["Vector"])
    links.new(rough_tex.outputs["Color"], bsdf.inputs["Roughness"])

    normal_tex = nodes.new("ShaderNodeTexImage")
    normal_tex.image = bpy.data.images.load(${JSON.stringify(floor.normal_path)}, check_existing=True)
    normal_tex.image.colorspace_settings.name = 'Non-Color'
    links.new(mapping.outputs["Vector"], normal_tex.inputs["Vector"])
    normal_map = nodes.new("ShaderNodeNormalMap")
    links.new(normal_tex.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])

    obj.data.materials.clear()
    obj.data.materials.append(mat)
`;
}

function hexToLinearRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return [toLinear(r), toLinear(g), toLinear(b)];
}

/**
 * Correlates Blender's synthetic "<Category><Index>" object names (e.g. "Chair2") back to
 * RoomPlan's own per-object identifier (UUID), by replaying the same per-category counting
 * Apple's USDZ exporter uses — verified against a real scan: walking walls/floors/objects in
 * their JSON array order and numbering each by prior occurrences of the same category
 * reproduces Blender's exact naming. There is no shared ID embedded in the USDZ itself.
 */
export function buildRoomPlanIdentifierMap(room: RoomPlanCapturedRoom): Map<string, string> {
  const map = new Map<string, string>();
  const counters: Record<string, number> = {};

  const walk = (entities: { identifier: string; category: Record<string, unknown> }[] | undefined) => {
    for (const entity of entities ?? []) {
      const category = Object.keys(entity.category ?? {})[0];
      if (!category) continue;
      const index = counters[category] ?? 0;
      counters[category] = index + 1;
      const blenderName = category.charAt(0).toUpperCase() + category.slice(1) + index;
      map.set(blenderName, entity.identifier);
    }
  };

  walk(room.walls);
  walk(room.floors);
  walk(room.objects);

  return map;
}

export interface RunStagingResult {
  summary: StagingSummary;
  exportFileUrl: string;
  previewFileUrl: string;
}

export async function runStaging(usdzUrl: string, serialized?: RoomPlanCapturedRoom): Promise<RunStagingResult> {
  const anthropic = anthropicClient();
  const [inspection, materials] = await Promise.all([bridge.inspectScene(usdzUrl), bridge.getMaterials()]);

  if (serialized) {
    const identifiers = buildRoomPlanIdentifierMap(serialized);
    for (const obj of inspection.objects) {
      const id = identifiers.get(obj.object_name);
      if (id) obj.roomplan_identifier = id;
    }
  }

  const objectsByName = new Map(inspection.objects.map((o) => [o.object_name, o]));
  const tools = buildTools(materials);

  const actions: StagingAction[] = [];
  const errors: string[] = [];
  const state: RunState = {
    hasRenderedPreview: false,
    hasSetWallColor: false,
    hasSetFloorMaterial: false,
    currentOccupants: new Map(inspection.objects.map((o) => [o.object_name, [o.object_name]])),
  };

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        "Mets en scène cette pièce à l'aide des outils fournis, puis appelle finish_staging quand tu as terminé.",
    },
  ];

  let finished = false;

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
      const output = await callTool(
        inspection.session_id,
        toolUse.name,
        toolUse.input,
        objectsByName,
        materials,
        actions,
        errors,
        state
      );
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: output });
      if (toolUse.name === "finish_staging" && output === "Staging finished.") finished = true;
    }

    messages.push({ role: "user", content: toolResults });
  }

  const preview = await bridge.renderPreview(inspection.session_id);
  const exported = await bridge.exportScene(inspection.session_id);

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

  return { summary, exportFileUrl: exported.file_url, previewFileUrl: preview.file_url };
}
