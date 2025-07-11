import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";

const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

function buildDpeFieldsSchema(wantedKeys: string[]) {
  return z.object(
    wantedKeys.reduce((acc, key) => ({ ...acc, [key]: z.string() }), {})
  );
}

export async function askOpenAIForFields(
  xmlSnippet: string,
  wantedKeys: string[],
  {
    model = DEFAULT_OPENAI_MODEL,
  }: { model?: string } = {}
): Promise<Record<string, string>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return {};

  const openai = new OpenAI({ apiKey });
  const DpeFieldsSchema = buildDpeFieldsSchema(wantedKeys);

  const sysPrompt =
    `Vous êtes un assistant qui extrait des informations précises d'un extrait XML provenant d'un diagnostic énergétique (DPE).\n` +
    `Les clés demandées sont exactement : ${wantedKeys.join(", ")}.\n` +
    `Lorsque l'information est absente ou inconnue, retourner la chaîne vide.`;

  try {
    const response = await openai.responses.parse({
      model,
      input: [
        { role: "system", content: sysPrompt },
        { role: "user", content: `XML :\n"""\n${xmlSnippet}\n"""` },
      ],
      text: { format: zodTextFormat(DpeFieldsSchema, "dpeFields") },
    });

    return response.output_parsed ?? {};
  } catch (e) {
    console.warn("OpenAI error", e);
    return {};
  }
} 