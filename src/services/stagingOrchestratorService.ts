import Anthropic from "@anthropic-ai/sdk";
import * as bridge from "./blenderBridgeService";
import { DetectedObject, SceneInspection, StagingAction, StagingSummary } from "../types/staging.types";

const DEFAULT_MODEL = process.env.ANTHROPIC_STAGING_MODEL || "claude-sonnet-5";
const MAX_TOOL_ROUNDS = 25;

function anthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY environment variable");
  return new Anthropic({ apiKey });
}

const tools: Anthropic.Tool[] = [
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
    description: "Paint one or more walls (by object_name from the room inspection, or \"all\").",
    input_schema: {
      type: "object",
      properties: {
        wall_object_names: { type: "array", items: { type: "string" } },
        all_walls: { type: "boolean", description: "Set true instead of listing names to paint every wall." },
        hex_color: { type: "string", description: "e.g. #E8E2D6" },
      },
      required: ["hex_color"],
    },
  },
  {
    name: "set_floor_material",
    description: "Change the floor color/finish.",
    input_schema: {
      type: "object",
      properties: {
        hex_color: { type: "string" },
        finish: { type: "string", enum: ["matte", "satin", "glossy"] },
      },
      required: ["hex_color", "finish"],
    },
  },
  {
    name: "finish_staging",
    description: "Call this once the room looks like a realistic, appealing, sellable staged scene.",
    input_schema: {
      type: "object",
      properties: {
        notes: { type: "string", description: "Short summary of the staging choices and why." },
      },
      required: ["notes"],
    },
  },
];

function systemPrompt(inspection: SceneInspection): string {
  return `Tu es un décorateur d'intérieur virtuel. Tu reçois le scan 3D (USDZ) d'une pièce déjà importé dans Blender, avec des objets déjà détectés (murs, sol, et du mobilier placé par le scan). Ton objectif : produire une mise en scène réaliste et vendeuse ("home staging"), en utilisant exclusivement le catalogue IKEA (recherche live via search_ikea).

Règles :
- Pour chaque meuble déjà détecté dans le scan, décide de le REMPLACER par un meuble IKEA de type/dimensions proches (replace_furniture), sauf s'il n'a pas d'équivalent pertinent.
- Tu peux aussi AJOUTER des meubles IKEA dans les zones vides pour compléter la pièce (place_furniture), sans jamais faire se chevaucher deux objets ni bloquer les portes/fenêtres.
- Après chaque place_furniture/replace_furniture, vérifie les dimensions réelles renvoyées (dimensions_cm) : si l'objet est manifestement trop grand/petit pour l'espace, cherche une meilleure alternative.
- Choisis une couleur de mur (set_wall_color) et un matériau/couleur de sol (set_floor_material) cohérents avec le style retenu, pour une ambiance chaleureuse qui donne envie d'acheter.
- Recherche toujours avec search_ikea avant de placer ou remplacer — n'invente jamais d'item_no.
- Les positions sont en mètres, dans le repère de la pièce fourni ci-dessous. Les rotations sont en degrés autour de l'axe Z.
- Quand la pièce est prête, appelle finish_staging avec un résumé court des choix faits.

Géométrie de la pièce (issue du scan) :
${JSON.stringify(inspection, null, 2)}`;
}

async function callTool(
  sessionId: string,
  name: string,
  input: any,
  objectsByName: Map<string, DetectedObject>,
  actions: StagingAction[],
  errors: string[]
): Promise<string> {
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
        });
      }

      case "replace_furniture": {
        const original = objectsByName.get(input.object_name);
        if (!original) return `ERROR: unknown object_name ${input.object_name} (not in room inspection)`;

        const position = input.position ?? original.position;
        const rotation = input.rotation_z_degrees ?? original.rotation_z_degrees;

        const result = await bridge.placeOrReplaceIkeaItem(sessionId, {
          itemNo: input.item_no,
          position,
          rotationZDegrees: rotation,
          replaceObjectName: input.object_name,
        });
        if (!result.success) {
          errors.push(result.output);
          return `ERROR: ${result.output}`;
        }

        actions.push({
          type: "replace",
          object_name: input.object_name,
          item_no: input.item_no,
          position,
          rotation_z_degrees: rotation,
        });
        return JSON.stringify({
          object_names: result.object_names,
          dimensions_cm: result.dimensions_cm,
        });
      }

      case "set_wall_color": {
        const targets: string[] = input.wall_object_names ?? [];

        const script = buildWallColorScript(input.all_walls ? "all" : targets, input.hex_color);
        const result = await bridge.executeScript(sessionId, script);
        if (!result.success) {
          errors.push(result.output);
          return `ERROR: ${result.output}`;
        }

        actions.push({
          type: "wall_color",
          wall_object_names: input.all_walls ? "all" : targets,
          hex_color: input.hex_color,
        });
        return `Wall color set to ${input.hex_color}.`;
      }

      case "set_floor_material": {
        const script = buildFloorMaterialScript(input.hex_color, input.finish);
        const result = await bridge.executeScript(sessionId, script);
        if (!result.success) {
          errors.push(result.output);
          return `ERROR: ${result.output}`;
        }

        actions.push({ type: "floor_material", hex_color: input.hex_color, finish: input.finish });
        return `Floor material set to ${input.hex_color} (${input.finish}).`;
      }

      case "finish_staging":
        return "Staging finished.";

      default:
        return `ERROR: unknown tool ${name}`;
    }
  } catch (e: any) {
    const message = e?.message ?? String(e);
    errors.push(message);
    return `ERROR: ${message}`;
  }
}

function buildWallColorScript(targets: string[] | "all", hexColor: string): string {
  const [r, g, b] = hexToLinearRgb(hexColor);
  const targetsExpr =
    targets === "all"
      ? "[o for o in bpy.data.objects if 'wall' in o.name.lower()]"
      : `[bpy.data.objects.get(n) for n in ${JSON.stringify(targets)}]`;
  return `
targets = ${targetsExpr}
for obj in targets:
    if obj is None:
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

function buildFloorMaterialScript(hexColor: string, finish: "matte" | "satin" | "glossy"): string {
  const [r, g, b] = hexToLinearRgb(hexColor);
  const roughness = finish === "glossy" ? 0.15 : finish === "satin" ? 0.4 : 0.75;
  return `
targets = [o for o in bpy.data.objects if 'floor' in o.name.lower()]
for obj in targets:
    mat = bpy.data.materials.get("staging_floor") or bpy.data.materials.new("staging_floor")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (${r}, ${g}, ${b}, 1.0)
        bsdf.inputs["Roughness"].default_value = ${roughness}
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

export interface RunStagingResult {
  summary: StagingSummary;
  exportFileUrl: string;
  previewFileUrl: string;
}

export async function runStaging(usdzUrl: string): Promise<RunStagingResult> {
  const anthropic = anthropicClient();
  const inspection = await bridge.inspectScene(usdzUrl);
  const objectsByName = new Map(inspection.objects.map((o) => [o.object_name, o]));

  const actions: StagingAction[] = [];
  const errors: string[] = [];

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
      max_tokens: 4096,
      system: systemPrompt(inspection),
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
        actions,
        errors
      );
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: output });
      if (toolUse.name === "finish_staging") finished = true;
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
