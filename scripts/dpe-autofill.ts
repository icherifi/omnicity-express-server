import 'dotenv/config';
import { parseStringPromise } from "xml2js";
import fetch from "node-fetch";
import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import {
  getValue,
  getValueByColumn,
  findValueWithText,
  mapPeriodeConstruction,
  mapTypeEnergie,
  mapTypeAppareilChauffage,
  isIleDeFrance,
  mapMatMenuiserieToLabel,
  mapTypeVitrageToLabel,
  mapVentilationCodeToLabel,
  mapSystemeEcsToLabel,
  inferEnergyFromGenerator,
  mapFiscalIncomeToInterval,
} from "../src/utils/form";

const IZI_API_URL = "https://qr.izi-by-edf.fr/api/socle/qr";
const IRENOV_API_URL = "https://api.irenov.izi-by-edf.fr/api/session";
const IZI_AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiJUZXN0IiwibmFtZSI6IlFSIFNlcnZpY2UiLCJpYXQiOjE1MTYyMzkyMzR9JngCUr2KcZHQ-AYl6esoTdE-t-cv6RfxvmbCBwaAItA";
const OPENAI_MODEL = "gpt-4o-mini";

interface StepResponse {
  nextStep: {
    id: string;
    node: {
      question: {
        label: string;
        type: string;
        choices?: { id: string; label: string }[];
      };
    };
  };
}
interface StepAnswer { answer: number | number[]; }

async function createIziSession(): Promise<any> {
  const resp = await fetch(`${IZI_API_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: IZI_AUTH_TOKEN },
    body: JSON.stringify({ slug: "simulation-renovation-energetique" }),
  });
  if (!resp.ok) throw new Error(`Création session IZI: ${resp.status}`);
  return resp.json();
}

async function sendStepIziAnswer(stepId: string, body: StepAnswer): Promise<StepResponse> {
  const resp = await fetch(`${IZI_API_URL}/steps/${stepId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/merge-patch+json",
      Authorization: IZI_AUTH_TOKEN,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Réponse step ${resp.status}: ${t}`);
  }
  return resp.json() as unknown as StepResponse;
}

async function sendToIRenov(responses: Record<string, any>): Promise<any> {
  console.log("=== ENVOI À IRENOV ===");
  console.log("Réponses envoyées:", JSON.stringify(responses, null, 2));
  
  const resp = await fetch(IRENOV_API_URL, {
    method: "POST",
    headers: { 
      "content-type": "application/json", 
      accept: "application/json, text/plain" 
    },
    body: JSON.stringify(responses),
  });
  
  if (!resp.ok) {
    const errorText = await resp.text();
    console.error("=== ERREUR IRENOV ===");
    console.error(`Status: ${resp.status}`);
    console.error(`Erreur: ${errorText}`);
    throw new Error(`Erreur iRenov: ${resp.status} - ${errorText}`);
  }
  
  const result = await resp.json();
  console.log("=== RÉSULTATS IRENOV ===");
  console.log(JSON.stringify(result, null, 2));
  console.log("=== FIN IRENOV ===");
  
  return result;
}

/** Aplatit un objet JSON issu du XML DPE en lignes [clé, valeur] */
function flattenObjectToRows(obj: any, rows: any[][], addEmptyFirstCol = false) {
  if (!obj) return;
  if (typeof obj === "object" && "description" in obj && "valeur" in obj) {
    rows.push(addEmptyFirstCol ? ["", obj.description, obj.valeur] : [obj.description, obj.valeur]);
    return;
  }
  Object.entries(obj).forEach(([k, v]) => {
    if (v === null || v === undefined) return;
    if (typeof v === "object") flattenObjectToRows(v, rows, addEmptyFirstCol);
    else rows.push(addEmptyFirstCol ? ["", k, String(v)] : [k, String(v)]);
  });
}

async function askOpenAIForFields(
  xmlSnippet: string,
  wantedKeys: string[],
): Promise<Record<string, string>> {
  const apiKey = process.env.OPENAI_API_KEY;
  console.log("=== VÉRIFICATION OPENAI ===");
  console.log("API Key définie:", !!apiKey);
  if (!apiKey) return {};

  const openai = new OpenAI({ apiKey });
  const DpeFieldsSchema = z.object(
    wantedKeys.reduce((acc, key) => ({ ...acc, [key]: z.string() }), {})
  );

  const sysPrompt =
    `Vous êtes un assistant qui extrait des informations précises d'un extrait XML provenant d'un diagnostic énergétique (DPE).\n` +
    `Les clés demandées sont exactement : ${wantedKeys.join(", ")}.\n` +
    `Lorsque l'information est absente ou inconnue, retourner la chaîne vide.`;

  try {
    console.log("=== ENVOI À OPENAI ===");
    console.log("Clés demandées:", wantedKeys);
    console.log("Prompt système:", sysPrompt);
    console.log("Extrait XML envoyé à l'IA:");
    console.log("```xml");
    console.log(xmlSnippet);
    console.log("```");
    const response = await openai.responses.parse({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: sysPrompt },
        { role: "user",   content: `XML :\n"""\n${xmlSnippet}\n"""` },
      ],
      text: { format: zodTextFormat(DpeFieldsSchema, "dpeFields") },
    });
    console.log("Réponse IA:", response.output_parsed ?? {});
    console.log("Réponse IA détaillée:");
    console.log(JSON.stringify(response.output_parsed, null, 2));
    console.log("=== FIN OPENAI ===");
    return response.output_parsed ?? {};
  } catch (e) {
    console.error("=== ERREUR OPENAI ===");
    console.error("Erreur complète:", e);
    if (e instanceof Error) {
      console.error("Message d'erreur:", e.message);
    }
    console.error("=== FIN ERREUR OPENAI ===");
    return {};
  }
}

async function buildFormData(xml: string): Promise<Record<string, any>> {
  const parsedXml = await parseStringPromise(xml, { explicitArray: false, mergeAttrs: true });
  const root = parsedXml?.dpe ?? parsedXml;

  const dpeRows: Record<string, any[][]> = { logement: [], logement_sortie: [], administratif: [], rapport: [] };
  ["administratif", "logement"].forEach(sheet => flattenObjectToRows(root[sheet], dpeRows[sheet]));
  flattenObjectToRows(root.logement?.sortie, dpeRows.logement_sortie, true);
  const rapportRows: any[][] = [];
  const push = (path: any) => flattenObjectToRows(path, rapportRows, true);
  push(root.logement?.descriptif_simplifie_collection);
  push(root.logement?.fiche_technique_collection);
  push(root.descriptif_simplifie_collection);
  push(root.fiche_technique_collection);
  push(root.logement?.ventilation_collection);
  push(root.logement?.installation_chauffage_collection);
  push(root.logement?.installation_ecs_collection);
  dpeRows.rapport = rapportRows;

  const { logement, administratif, rapport } = dpeRows;

  const codePostal = getValue(administratif, "code_postal_brut") ?? "";
  const surfaceRaw = getValue(logement, "surface_habitable_logement");
  const surfaceHabitable = surfaceRaw ? String(Math.round(parseFloat(surfaceRaw))) : "";
  const surfaceForForm = surfaceHabitable && parseFloat(surfaceHabitable) < 35 ? "35" : surfaceHabitable;
  let nbNiveaux = "";
  let nbNiveauxRaw: string | null | undefined = getValue(logement, "nombre_niveau_logement");

  if (!nbNiveauxRaw) {
    // Fallback : rechercher dans les lignes du rapport
    const alt = findAny(rapport, [/nombre\s+de\s+niveaux.*logement/i, /nombre\s+niveau\s+logement/i]);
    if (alt) nbNiveauxRaw = alt;
  }

  if (nbNiveauxRaw) {
    const match = String(nbNiveauxRaw).match(/\d+/);
    if (match) {
      const n = parseInt(match[0], 10);
      if (!isNaN(n)) nbNiveaux = String(Math.min(4, Math.max(1, n)));
    }
  }

  if (!nbNiveaux) nbNiveaux = "1";

  let periodeRaw = getValue(logement, "annee_construction") ?? getValue(logement, "periode_construction");
  if (!periodeRaw) {
    periodeRaw = findValueWithText(rapport, /année\s+de\s+construction/i)
              ?? findAny(rapport, [/\d{4}\s*[–-]\s*\d{4}/], 2, 2);
    if (periodeRaw?.includes(":")) periodeRaw = periodeRaw.split(":").pop()?.trim() || null;
  }

  if (periodeRaw && !/\d{4}/.test(periodeRaw)) periodeRaw = null;
  if (!periodeRaw) periodeRaw = 'Entre 1948 et 1974';

  // Récupération du libellé de l'appareil de chauffage (générateur)
  let generatorDeviceRaw = getValueByColumn(rapport, "type générateur")
                       ?? getValueByColumn(rapport, "générateur type");

  // Si le champ récupéré est vide ou correspond manifestement à un ballon ECS,
  // on tente de repérer un radiateur électrique (fluide caloporteur, convecteur, etc.)
  if (!generatorDeviceRaw || /ballon.*electrique/.test(generatorDeviceRaw.toLowerCase())) {
    const altGen = findAny(rapport, [
      /radiateur.*fluide.*caloporteur/i,
      /radiateur.*electrique/i,
      /radiateur.*électrique/i,
      /radiateur.*élec/i,
      /convecteur/i,
      /panneau.*rayonnant/i,
      /effet\s+joule/i,
    ]);
    if (altGen) generatorDeviceRaw = altGen;
  }

  // Source d'énergie principale du chauffage
  let energySourceHeatingRaw = inferEnergyFromGenerator(generatorDeviceRaw);

  if (!energySourceHeatingRaw) {
    energySourceHeatingRaw = getValueByColumn(rapport, "energie utilisée", 1, 2);
    
    if (energySourceHeatingRaw) {
      const energyRowIndex = rapport.findIndex(r => r[1]?.toLowerCase() === "energie utilisée");
      const prev = rapport.slice(Math.max(0, energyRowIndex - 4), energyRowIndex)
                          .some(r => /installation.+chauffage|type g[ée]n[ée]rateur/.test(String(r[1]??"").toLowerCase()));
      if (!prev) energySourceHeatingRaw = null;
    }
  }

  let typeVentilationRaw = findAny(rapport, [/ventilation/i, /vmc/i, /vh\b/i])
                        ?? findAny(rapport, [/ventilation/i], 2, 2) ?? "";
  let typeVitrageRaw = getValueByColumn(rapport, "type de vitrage")
                    ?? findAny(rapport, [/vitrage/i]) ?? "";
  let matMenuiserieRaw = findAny(rapport, [/menuiserie/i])
                      ?? findAny(rapport, [/menuiserie/i], 2, 2) ?? "";
  let systemeEcsRaw = getValueByColumn(rapport, "type production ecs")
                   ?? findAny(rapport, [/ballon|ecs|chauffe/i]);

  if (!/[sd]imple|double|triple/i.test(typeVitrageRaw)) {
    typeVitrageRaw = findAny(rapport, [
      /simple\s*vitrage/i,
      /double\s*vitrage/i,
      /triple\s*vitrage/i,
      /simplevitrage/i,
      /doublevitrage/i,
      /triplevitrage/i,
    ]) ?? typeVitrageRaw;
  }
  if (/toute\s+menuiserie/i.test(matMenuiserieRaw ?? "")) {
    matMenuiserieRaw = findAny(rapport, [/pvc/i, /alu|minium/i, /bois/i]) ?? matMenuiserieRaw;
  }
  if (!systemeEcsRaw) {
    systemeEcsRaw = findAny(rapport, [/chauffe[- ]eau/i, /thermodynam/i]);
  }

  // Nouvel heuristique : déduire le matériau de menuiserie si absent, à partir du libellé de vitrage
  if (!matMenuiserieRaw && typeVitrageRaw) {
    const tv = typeVitrageRaw.toLowerCase();
    if (/pvc/.test(tv))      matMenuiserieRaw = 'pvc';
    else if (/bois/.test(tv)) matMenuiserieRaw = 'bois';
    else if (/alu|minium/.test(tv)) matMenuiserieRaw = 'aluminium';
  }

  const unknownMap: Record<string, string | null> = {
    generatorDeviceRaw, energySourceHeatingRaw, typeVentilationRaw,
    typeVitrageRaw, matMenuiserieRaw, systemeEcsRaw,
  };
  console.log("=== DÉBOGAGE VALEURS MANQUANTES ===");
  console.log("Valeurs extraites:", unknownMap);
  const missing = Object.entries(unknownMap)
    .filter(([, v]) => !v || /inconnu/i.test(v))
    .map(([k]) => k);
  console.log("Clés manquantes détectées:", missing);
  console.log("=== FIN DÉBOGAGE ===");
  if (missing.length) {
    const snippet = rapport.join("\n");
    const ai = await askOpenAIForFields(snippet, missing);
    missing.forEach(k => { if (ai[k]) unknownMap[k] = ai[k]; });

    ({ generatorDeviceRaw, energySourceHeatingRaw, typeVentilationRaw,
       typeVitrageRaw, matMenuiserieRaw, systemeEcsRaw } = unknownMap as any);
  }

  return {
    "L'année de construction du logement": [mapPeriodeConstruction(periodeRaw)],
    "La maison est-elle mitoyenne ?": ["Non"],
    "Le nombre de niveaux habités": [nbNiveaux],
    "Le type d'appareil de votre chauffage principal": [mapTypeAppareilChauffage(generatorDeviceRaw)],
    "Le type de toiture": ["Combles perdus"],
    "Possédez-vous un second type de chauffage ?": ["Non"],
    "Quel appareil produit votre eau chaude sanitaire ?": [mapSystemeEcsToLabel(systemeEcsRaw)],
    "Quel est le matériau de vos fenêtres ?": [mapMatMenuiserieToLabel(matMenuiserieRaw)],
    "Quel est le type de ventilation ?": [mapVentilationCodeToLabel(typeVentilationRaw)],
    "Quel est votre type de planchers bas ?": ["Cave ou sous-sol"],
    "Quelle est la source d'énergie de chauffage principale ?": [mapTypeEnergie(energySourceHeatingRaw)],
    "Sa forme": ["Rectangulaire compacte"],
    "Sa surface habitable (m²)": surfaceForForm,
    "Vous habitez": [isIleDeFrance(codePostal)],
    "Avez-vous déjà effectué des travaux d'isolation de vos murs ?": ["Je ne sais pas"],
    "Avez-vous déjà effectué des travaux d'isolation de votre toiture ?": ["Je ne sais pas"],
    "Avez-vous déjà effectué des travaux d'isolation de vos planchers bas ?": ["Je ne sais pas"],
    "Code Postal": codePostal,
    "Comment est le vitrage de vos fenêtres ?": [mapTypeVitrageToLabel(typeVitrageRaw)],
    "Par rapport au logement, vous êtes ?": ["Propriétaire résidence principale"],
    "Nombre d'habitants composant votre foyer fiscal": ["2"],
  } as Record<string, any>;
}

async function run(dpeNumber: string) {
  console.log("➡️  Récupération du XML DPE", dpeNumber);
  const xmlResp = await fetch(`https://prd-x-ademe-externe-api.de-c1.eu1.cloudhub.io/api/v1/pub/dpe/${dpeNumber}/xml`, {
    headers: {
      client_id: "f15319ce605e407581242b71425bbcb6",
      client_secret: "4d97b25a303b412eB968C26Aef30D933",
    },
  });
  if (!xmlResp.ok) throw new Error(`DPE ${xmlResp.status}`);
  const xmlText = await xmlResp.text();

  const formData = await buildFormData(xmlText);

  const session = await createIziSession();
  let currentStep = session.currentStep;
  let incomeQuestion: any = null;

  while (currentStep?.node?.question) {
    const q = currentStep.node.question;
    
    // Traiter la question des revenus normalement
    if (q.label === "Revenu annuel moyen de votre foyer fiscal") {
      incomeQuestion = q;
      console.log(`✔️  ${q.label} -> Traitement spécial (revenu fiscal)`);
      if (q.choices) {
        console.log("Choix disponibles pour cette question :");
        q.choices.forEach((choice: { id: string; label: string }, idx: number) => {
          console.log(`  ${idx + 1}. "${choice.label}" (ID: ${choice.id})`);
        });
      }
      
      // Utiliser une valeur par défaut pour les revenus
      const defaultIncome = "35000";
      const mappedIncome = mapFiscalIncomeToInterval(defaultIncome, q.choices || []);
      console.log(`Réponse sélectionnée pour revenus : "${mappedIncome}"`);
      
      const ch = q.choices?.find((c: { id: string; label: string }) => c.label === mappedIncome);
      if (ch) {
        const body = { answer: [ch.id] };
        console.log(`Envoi de la réponse revenus : ${mappedIncome} (ID: ${ch.id})`);
        const stepData = await sendStepIziAnswer(currentStep.id, body);
        currentStep = stepData.nextStep;
      } else {
        console.warn("Aucun choix trouvé pour les revenus, passage à l'étape suivante");
        currentStep = currentStep.nextStep;
      }
      continue;
    }
    
    const labelSan = q.label.replace(":", "").trim();
    const answer = formData[labelSan as keyof typeof formData];
    if (!answer) {
      console.warn("Pas de réponse pour", q.label);
      break;
    }
    let body: StepAnswer | null = null;
    if (q.type === "QuestionChoice") {
      const ch = q.choices?.find((c: { id: string; label: string }) => c.label === (Array.isArray(answer) ? answer[0] : answer));
      if (ch) body = { answer: [ch.id] };
    } else if (q.type === "QuestionInteger") {
      const val = parseInt(Array.isArray(answer) ? answer[0] : answer, 10);
      if (!isNaN(val)) body = { answer: val };
    }
    if (q.choices) {
      console.log("Choix disponibles pour cette question :");
      q.choices.forEach((choice: { id: string; label: string }, idx: number) => {
        console.log(`  ${idx + 1}. "${choice.label}" (ID: ${choice.id})`);
      });
      console.log("Réponse sélectionnée :", Array.isArray(answer) ? answer[0] : answer);
    }
    if (!body) {
      console.warn("Format réponse invalide", q.label, answer);
      console.warn("=== DÉBOGAGE RÉPONSE INVALIDE ===");
      console.warn("Question:", q.label);
      console.warn("Réponse trouvée:", answer);
      console.warn("Type de question:", q.type);
      if (q.choices) {
        console.warn("Choix possibles pour cette question:");
        q.choices.forEach((choice: { id: string; label: string }, index: number) => {
          console.warn(`  ${index + 1}. \"${choice.label}\" (ID: ${choice.id})`);
        });
      }
      console.warn("=== FIN DÉBOGAGE ===");
      break;
    }
    console.log(`✔️  ${q.label} -> ${Array.isArray(answer) ? answer[0] : answer}`);
    const stepData = await sendStepIziAnswer(currentStep.id, body);
    currentStep = stepData.nextStep;
  }

  const summary = await (await fetch(`${IZI_API_URL}/sessions/${session.id}/result`, { headers: { Authorization: IZI_AUTH_TOKEN } })).json();
  console.log("=== RÉSUMÉ IZI ===");
  console.log(JSON.stringify(summary, null, 2));

  // Préparer les réponses complètes pour iRenov
  const completeResponses: Record<string, any> = { 
    ...formData, 
    ...(typeof summary === 'object' && summary !== null ? summary : {})
  };
  
  // Corriger la structure comme dans form.ts
  const responses: Record<string, any> = { ...completeResponses };
  responses["Code Postal"] = formData["Code Postal"];
  
  // Nettoyer uniquement les valeurs vides ou nulles (on conserve désormais toutes les clés, y compris celles du résumé IZI terminant par " :")
  const cleanedResponses: Record<string, any> = {};
  Object.entries(responses).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "" ||
        (Array.isArray(value) && value.length === 0) ||
        (Array.isArray(value) && value[0] === "")) return;
    cleanedResponses[key] = value;
  });
  
  try {
    const iRenovResult = await sendToIRenov(cleanedResponses);
    
    console.log("=== ANALYSE DÉTAILLÉE DES DONNÉES ===");
    console.log("Nombre total de champs:", Object.keys(cleanedResponses).length);
    console.log("Champs avec tableaux:", Object.entries(cleanedResponses).filter(([, v]) => Array.isArray(v)).map(([k]) => k));
    console.log("Champs avec chaînes:", Object.entries(cleanedResponses).filter(([, v]) => !Array.isArray(v)).map(([k]) => k));
    console.log("=== FIN ANALYSE ===");
    
    console.log("=== SUCCÈS COMPLET ===");
    console.log("✅ Formulaire IZI rempli avec succès");
    console.log("✅ Résultats iRenov obtenus");
    console.log("✅ Script terminé avec succès");
    return iRenovResult;
  } catch (error) {
    console.error("=== ÉCHEC DU SCRIPT ===");
    console.error("❌ Erreur lors de l'envoi à iRenov:", error);
    console.error("❌ Données qui ont causé l'erreur:");
    console.error(JSON.stringify(cleanedResponses, null, 2));
    console.error("❌ Script terminé avec échec");
    throw error;
  }
}

function findAny(rows: any[][], regexes: RegExp[], col = 1, valCol = 2): string | null {
  for (const rx of regexes) {
    const v = findValueWithText(rows, rx, col, valCol);
    if (v) return v;
  }
  return null;
}

if (require.main === module) {
  const dpeNum = process.argv[2];
  if (!dpeNum) {
    console.error("Usage: ts-node dpe-autofill.ts <DPE_NUMBER>");
    process.exit(1);
  }
  run(dpeNum).catch(e => { console.error(e); process.exit(1); });
}
