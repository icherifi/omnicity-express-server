import { Request, Response } from "express";
import { parseStringPromise } from "xml2js";
import {
  getValue,
  getValues,
  getValueByColumn,
  findValueWithText,
  mapPeriodeConstruction,
  mapTypeEnergie,
  mapTypeAppareilChauffage,
  isIleDeFrance,
  mapOccupancyStatusToLabel,
  mapTypeVitrageToLabel,
  mapMatMenuiserieToLabel,
  mapVentilationCodeToLabel,
  mapSystemeEcsToLabel,
  mapFiscalIncomeToInterval,
  inferEnergyFromGenerator,
} from "../../utils/form";
import { DpeFormattedData } from "../../types/dpe.types";
import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";





const IZI_API_URL     = "https://qr.izi-by-edf.fr/api/socle/qr";
const IRENOV_API_URL  = "https://api.irenov.izi-by-edf.fr/api/session";
const IZI_AUTH_TOKEN  = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiJUZXN0IiwibmFtZSI6IlFSIFNlcnZpY2UiLCJpYXQiOjE1MTYyMzkyMzR9JngCUr2KcZHQ-AYl6esoTdE-t-cv6RfxvmbCBwaAItA";
const OPENAI_MODEL    = "gpt-4o-mini";





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

interface DpeData {
  logement:           any[][];
  logement_sortie:    any[][];
  administratif:      any[][];
  rapport:            any[][];
  [k: string]:        any[][];
}





async function askOpenAIForFields(
  xmlSnippet: string,
  wantedKeys: string[],
): Promise<Record<string, string>> {
  const apiKey = process.env.OPENAI_API_KEY;
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
    const response = await openai.responses.parse({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: sysPrompt },
        { role: "user",   content: `XML :\n"""\n${xmlSnippet.substring(0, 8000)}\n"""` },
      ],
      text: { format: zodTextFormat(DpeFieldsSchema, "dpeFields") },
    });
    return response.output_parsed ?? {};
  } catch (e) {
    console.warn("OpenAI error", e);
    return {};
  }
}





async function createIziSession(): Promise<any> {
  const resp = await fetch(`${IZI_API_URL}/sessions`, {
    method : "POST",
    headers: { "Content-Type": "application/json", Authorization: IZI_AUTH_TOKEN },
    body   : JSON.stringify({ slug: "simulation-renovation-energetique" }),
  });
  if (!resp.ok) throw new Error(`Erreur création session: ${resp.status}`);
  return resp.json();
}

async function sendStepIziAnswer(stepId: string, answerBody: StepAnswer): Promise<StepResponse> {
  const resp = await fetch(`${IZI_API_URL}/steps/${stepId}`, {
    method : "PATCH",
    headers: {
      "Content-Type": "application/merge-patch+json",
      Authorization : IZI_AUTH_TOKEN,
    },
    body: JSON.stringify(answerBody),
  });
  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Erreur lors de l'envoi de la réponse: ${resp.status} - ${errorText}`);
  }
  return resp.json();
}





function findAny(rows: any[][], regexes: RegExp[], col = 1, valCol = 2): string | null {
  for (const rx of regexes) {
    const v = findValueWithText(rows, rx, col, valCol);
    if (v) return v;
  }
  return null;
}

async function mapDpeToFormData(dpe: DpeData): Promise<DpeFormattedData> {
  const { logement, administratif, rapport } = dpe;

  
  const codePostal     = getValue(administratif, "code_postal_brut") ?? "";
  const surfaceRaw     = getValue(logement, "surface_habitable_logement");
  const surfaceHabitable = surfaceRaw ? String(Math.round(parseFloat(surfaceRaw))) : "";
  const nbNiveaux      = getValue(logement, "nombre_niveau_logement") ?? "";

  
  let periodeRaw = getValue(logement, "annee_construction")
                ?? getValue(logement, "periode_construction");
  if (!periodeRaw) {
    periodeRaw = findValueWithText(rapport, /année\s+de\s+construction/i)
              ?? findAny(rapport, [/\d{4}\s*[–-]\s*\d{4}/], 2, 2);
    if (periodeRaw?.includes(":")) periodeRaw = periodeRaw.split(":").pop()?.trim() || null;
  }

  
  
 
  let typeGenerateurRaw = getValueByColumn(rapport, "type générateur") 
                        ?? findAny(rapport, [/type\s+g[ée]n[ée]rateur/i, /chaudi[èe]re|pac|pompe/i]);

 
  let energieChauffageRaw = inferEnergyFromGenerator(typeGenerateurRaw);

 
  if (!energieChauffageRaw) {
    energieChauffageRaw = getValueByColumn(
        rapport,
        "energie utilisée",
     1,  2
    );
    
   
   
   
    if (energieChauffageRaw) {
      const energyRowIndex = rapport.findIndex(r => r[1]?.toLowerCase() === "energie utilisée");
      const prev = rapport.slice(Math.max(0, energyRowIndex - 4), energyRowIndex)       
                          .some(r => /installation.+chauffage|type g[ée]n[ée]rateur/.test(String(r[1]??"").toLowerCase()));
      if (!prev) energieChauffageRaw = null; 
    }
  }

  let typeVentilationRaw = findAny(rapport, [/ventilation/i, /vmc/i, /vh\b/i])
                        ?? findAny(rapport, [/ventilation/i], 2, 2) ?? "";
  let typeVitrageRaw     = getValueByColumn(rapport, "type de vitrage")
                        ?? findAny(rapport, [/vitrage/i]) ?? "";
  let matMenuiserieRaw   = findAny(rapport, [/menuiserie/i]) 
                        ?? findAny(rapport, [/menuiserie/i], 2, 2) ?? "";
  let systemeEcsRaw      = getValueByColumn(rapport, "type production ecs")
                        ?? findAny(rapport, [/ballon|ecs|chauffe/i]);

 
  if (!/[sd]imple|double|triple/i.test(typeVitrageRaw)) {
    typeVitrageRaw = findAny(rapport, [
      /simple\s+vitrage/i,
      /double\s+vitrage/i,
      /triple\s+vitrage/i,
    ]) ?? typeVitrageRaw;
  }
  if (/toute\s+menuiserie/i.test(matMenuiserieRaw ?? "")) {
    matMenuiserieRaw = findAny(rapport, [/pvc/i, /alu|minium/i, /bois/i]) ?? matMenuiserieRaw;
  }
  if (!systemeEcsRaw) {
    systemeEcsRaw = findAny(rapport, [/chauffe[- ]eau/i, /thermodynam/i]);
  }

  
  const unknownMap: Record<string,string | null> = {
    typeGenerateurRaw, energieChauffageRaw, typeVentilationRaw,
    typeVitrageRaw, matMenuiserieRaw, systemeEcsRaw,
  };
  const missing = Object.entries(unknownMap)
    .filter(([,v]) => !v || /inconnu/i.test(v))
    .map(([k]) => k);
  if (missing.length) {
    const snippet = dpe.rapport.join("\n");
    const ai      = await askOpenAIForFields(snippet, missing);
    missing.forEach(k => { if (ai[k]) unknownMap[k] = ai[k]; });

    ({ typeGenerateurRaw, energieChauffageRaw, typeVentilationRaw,
       typeVitrageRaw, matMenuiserieRaw, systemeEcsRaw } = unknownMap as any);
  }


  
  const formData: DpeFormattedData = {
    "L'année de construction du logement"           : [mapPeriodeConstruction(periodeRaw)],
    "La maison est-elle mitoyenne ?"                : ["Non"],
    "Le nombre de niveaux habités"                  : [nbNiveaux],
    "Le type d'appareil de votre chauffage principal": [mapTypeAppareilChauffage(typeGenerateurRaw)],
    "Le type de toiture"                            : ["Combles perdus"],
    "Possédez-vous un second type de chauffage ?"   : ["Non"],
    "Quel appareil produit votre eau chaude sanitaire ?" : [mapSystemeEcsToLabel(systemeEcsRaw)],
    "Quel est le matériau de vos fenêtres ?"        : [mapMatMenuiserieToLabel(matMenuiserieRaw)],
    "Quel est le type de ventilation ?"             : [mapVentilationCodeToLabel(typeVentilationRaw)],
    "Quel est votre type de planchers bas ?"        : ["Cave ou sous-sol"],
    "Quelle est la source d'énergie de chauffage principale ?" : [mapTypeEnergie(energieChauffageRaw)],
    "Sa forme"                                      : ["Rectangulaire compacte"],
    "Sa surface habitable (m²)"                     : surfaceHabitable,
    "Vous habitez"                                  : [isIleDeFrance(codePostal)],
    "Avez-vous déjà effectué des travaux d'isolation de vos murs ?"       : ["Je ne sais pas"],
    "Avez-vous déjà effectué des travaux d'isolation de votre toiture ?"  : ["Je ne sais pas"],
    "Avez-vous déjà effectué des travaux d'isolation de vos planchers bas ?": ["Je ne sais pas"],
    "Code Postal"                                   : codePostal,
    "Comment est le vitrage de vos fenêtres ?"      : [mapTypeVitrageToLabel(typeVitrageRaw)],
  };

  return formData;
}





function flattenObjectToRows(obj: any, rows: any[][], addEmptyFirstCol = false) {
  if (!obj) return;
  if (typeof obj === "object" && obj !== null && "description" in obj && "valeur" in obj) {
    rows.push(addEmptyFirstCol
      ? ["", obj.description, obj.valeur]
      : [obj.description, obj.valeur]);
    return;
  }
  Object.entries(obj).forEach(([key, val]) => {
    if (val === null || val === undefined) return;
    if (typeof val === "object") {
      flattenObjectToRows(val, rows, addEmptyFirstCol);
    } else {
      rows.push(addEmptyFirstCol
        ? ["", key, String(val)]
        : [key, String(val)]);
    }
  });
}





function extractDpeMetrics(data: DpeData) {
  const logementRows       = data.logement        ?? [];
  const logementSortieRows = data.logement_sortie ?? [];
  const rapportRows        = data.rapport        ?? [];

  const wallSurfaces: number[] = [];
  logementRows.forEach((r, i) => {
    if (r[0] === "enum_materiaux_structure_mur_id") {
      for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
        if (logementRows[j][0] === "surface_paroi_opaque") {
          wallSurfaces.push(Number(logementRows[j][1]));
          break;
        }
      }
    }
  });
  const totalWallSurface = wallSurfaces.reduce((s, n) => s + n, 0);

  const baySurfaces = getValues(logementRows, "surface_totale_baie").map(Number);
  const nbBays      = getValues(logementRows, "nb_baie")
                        .map(Number).reduce((s, n) => s + n, 0);
  const totalBaySurface = baySurfaces.reduce((s, n) => s + n, 0);

  const gv = (k: string) => getValueByColumn(logementSortieRows, k, 1, 2);

  const ventilatedSurface = Number(
    getValue(logementRows, "surface_ventile") || gv("surface_ventile") || 0
  );

  const doorSurfaces = getValues(logementRows, "surface_porte", 0, 1)
                         .map(Number);
  const totalDoorSurface = doorSurfaces.reduce((s, n) => s + n, 0);

  return {
    wallSurfaces, totalWallSurface,
    baySurfaces,  totalBaySurface, nbBays,
    ventilatedSurface,
    heatingNeed      : Number(gv("besoin_ch")),
    heatLossRate     : Number(gv("deperdition_enveloppe")),
    doorSurface      : totalDoorSurface,

    costs: {
      heating : gv("cout_ch"),
      ecs     : gv("cout_ecs"),
      lighting: gv("cout_eclairage"),
      aux     : gv("cout_total_auxiliaire"),
    },

    travaux: {
      conso5UsagesApresTravaux      : getValueByColumn(data.rapport, "conso_5_usages_apres_travaux", 1, 2),
      emissionGes5UsagesApresTravaux: getValueByColumn(data.rapport, "emission_ges_5_usages_apres_travaux", 1, 2),
    },
  };
}






export async function autoFillForm(req: Request, res: Response) {
  try {
    const { dpeNumber, fiscalIncome, householdSize, occupancyStatus } = req.body;
    if (!dpeNumber) return res.status(400).json({ error: "Le numéro de DPE est requis" });

    
    const xmlUrl  = `https://prd-x-ademe-externe-api.de-c1.eu1.cloudhub.io/api/v1/pub/dpe/${dpeNumber}/xml`;
    const dpeResp = await fetch(xmlUrl, {
      headers: {
        client_id    : "f15319ce605e407581242b71425bbcb6",
        client_secret: "4d97b25a303b412eB968C26Aef30D933",
        "Content-Type": "application/json",
      },
    });
    if (!dpeResp.ok) throw new Error(`Erreur DPE ${dpeResp.status}: ${dpeResp.statusText}`);
    const xmlText   = await dpeResp.text();
    const parsedXml = await parseStringPromise(xmlText, { explicitArray: false, mergeAttrs: true });

    
    const dpeData: DpeData = { logement: [], logement_sortie: [], administratif: [], rapport: [] };
    const root   = parsedXml?.dpe ?? parsedXml;

    (["administratif", "logement"] as const).forEach(sheet => {
      const sec = root[sheet];
      if (!sec) return;
      flattenObjectToRows(sec, dpeData[sheet]);
    });

    
    flattenObjectToRows(root.logement?.sortie, dpeData.logement_sortie, true);

    
    const rapportRows: any[][] = [];
    flattenObjectToRows(root.logement?.descriptif_simplifie_collection, rapportRows, true);
    flattenObjectToRows(root.logement?.fiche_technique_collection,   rapportRows, true);
    flattenObjectToRows(root.descriptif_simplifie_collection,        rapportRows, true);
    flattenObjectToRows(root.fiche_technique_collection,             rapportRows, true);
    flattenObjectToRows(root.logement?.ventilation_collection,       rapportRows, true);
    flattenObjectToRows(root.logement?.installation_chauffage_collection, rapportRows, true);
    flattenObjectToRows(root.logement?.installation_ecs_collection,  rapportRows, true);
    flattenObjectToRows(root.descriptif_travaux,                       rapportRows, true);
    dpeData.rapport = rapportRows;

    
    const session      = await createIziSession();
    let   currentStep  = session.currentStep;
    let   incomeQuestion: any = null;

    const formData         = await mapDpeToFormData(dpeData);
    const completeFormData = {
      ...formData,
      "Nombre d'habitants composant votre foyer fiscal": [householdSize],
      "Par rapport au logement, vous êtes ?"           : [mapOccupancyStatusToLabel(occupancyStatus)],
    };

    const pick = (label: keyof typeof formData) =>
      Array.isArray(formData[label]) ? formData[label][0] : formData[label];

    const periodeConstruction = pick("L'année de construction du logement");
    const typeGenerateur      = pick("Le type d'appareil de votre chauffage principal");
    const typeVentilation     = pick("Quel est le type de ventilation ?");
    const typeVitrage         = pick("Comment est le vitrage de vos fenêtres ?");
    const materiauxMenuiserie = pick("Quel est le matériau de vos fenêtres ?");
    const systemeEcs          = pick("Quel appareil produit votre eau chaude sanitaire ?");

    
    while (currentStep?.node?.question) {
      if (currentStep.node.question.label === "Revenu annuel moyen de votre foyer fiscal") {
        incomeQuestion = currentStep.node.question;
        currentStep    = currentStep.nextStep;
        continue;
      }

      const qLabel = currentStep.node.question.label.replace(":", "").trim() as keyof typeof completeFormData;
      const answer = completeFormData[qLabel];
      if (!answer) { console.warn(`Pas de réponse pour ${qLabel}`); break; }

      let answerBody: StepAnswer | null = null;
      if (currentStep.node.question.type === "QuestionChoice") {
        const choice = currentStep.node.question.choices?.find((c: any) => c.label === answer[0]);
        if (choice) answerBody = { answer: [choice.id] };
      } else if (currentStep.node.question.type === "QuestionInteger") {
        const val = parseFloat(Array.isArray(answer) ? answer[0] : answer);
        if (!isNaN(val)) answerBody = { answer: Math.round(val) };
      }

      if (!answerBody) { console.warn(`Réponse invalide pour ${qLabel}`); break; }
      const stepData  = await sendStepIziAnswer(currentStep.id, answerBody);
      currentStep     = stepData.nextStep;
    }

    
    const summaryResp = await fetch(`${IZI_API_URL}/sessions/${session.id}/result`, {
      headers: { Authorization: IZI_AUTH_TOKEN },
    });
    if (!summaryResp.ok) throw new Error(`Erreur résumé: ${summaryResp.status}`);
    const summaryData = await summaryResp.json();

    const responses: Record<string,any> = { ...completeFormData, ...summaryData };
    responses["Code Postal"] = formData["Code Postal"];
    responses["Revenu annuel moyen de votre foyer fiscal"] = [
      mapFiscalIncomeToInterval(fiscalIncome, incomeQuestion?.choices || []),
    ];

    const iRenovResp = await fetch(IRENOV_API_URL, {
      method : "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/plain" },
      body   : JSON.stringify(responses),
    });
    if (!iRenovResp.ok) {
      const errorText = await iRenovResp.text();
      throw new Error(`Erreur iRenov: ${iRenovResp.status} - ${errorText}`);
    }
    const finalData = await iRenovResp.json();

    
    const metrics = extractDpeMetrics(dpeData);

    const relevantDpeData = {
      codePostal         : getValue(dpeData.administratif, "code_postal_brut"),
      adresse            : getValue(dpeData.administratif, "label_brut"),
      periodeConstruction: periodeConstruction,
      surfaceHabitable   : getValue(dpeData.logement,      "surface_habitable_logement"),
      typeGenerateur     : typeGenerateur,
      typeVentilation    : typeVentilation,
      typeVitrage        : typeVitrage,
      materiauxMenuiserie: materiauxMenuiserie,
      nombreNiveaux      : getValue(dpeData.logement,      "nombre_niveau_logement"),
      systemeEcs         : systemeEcs,

      caracteristiques: {
        taille        : Math.round(Number(getValue(dpeData.logement, "surface_habitable_logement") || 0)).toString(),
        nombrePieces  : 0,
        nombreEtages  : Number(getValue(dpeData.logement, "nombre_niveau_logement")),
      },

      quantites: {
        murs      : { surfaces: metrics.wallSurfaces, total: metrics.totalWallSurface },
        fenetres  : { nombre  : metrics.nbBays,        surface: metrics.totalBaySurface },
        portes    : { surface : metrics.doorSurface },
        ventilation: {
          typeActuel: typeVentilation,
          surface   : metrics.ventilatedSurface,
        },
        chauffage : {
          besoinKWh: metrics.heatingNeed,
          perteWK  : metrics.heatLossRate,
        },
      },
    
      couts: {
        chauffage  : metrics.costs.heating,
        ecs        : metrics.costs.ecs,
        eclairage  : metrics.costs.lighting,
        auxiliaires: metrics.costs.aux,
        autres     : (
           Number(metrics.costs.lighting) +
           Number(metrics.costs.aux)
        ).toString(),
        total      : (
          Number(metrics.costs.heating) +
          Number(metrics.costs.ecs)     +
          Number(metrics.costs.lighting)+
          Number(metrics.costs.aux)
        ).toString(),
      },

      travaux: {
        pack: {
          conso5UsagesApresTravaux      : metrics.travaux.conso5UsagesApresTravaux,
          emissionGes5UsagesApresTravaux: metrics.travaux.emissionGes5UsagesApresTravaux,
        },
      },
    };

    
    return res.status(200).json({
      iziResponse: finalData,
      dpeData    : relevantDpeData,
      sessionId  : session.id,
    });

  } catch (err: any) {
    console.error("Erreur détaillée :", err);
    return res.status(500).json({
      error  : "Erreur lors du remplissage automatique du formulaire",
      details: err.message,
    });
  }
}





export async function createIziSessionHandler(req: Request, res: Response) {
  try   { return res.json(await createIziSession()); }
  catch (e:any) { return res.status(500).json({ error: e.message }); }
}

export async function sendStepIziAnswerHandler(req: Request, res: Response) {
  try {
    const { stepId, answer } = req.body;
    if (!stepId || !answer) return res.status(400).json({ error: "stepId et answer sont requis" });
    const data = await sendStepIziAnswer(stepId, { answer });
    return res.json(data);
  } catch (e:any) {
    return res.status(500).json({ error: e.message });
  }
}

export async function getQuizSummary(req: Request, res: Response) {
  const { sessionId } = req.params;
  const resp = await fetch(`${IZI_API_URL}/sessions/${sessionId}/result`, {
    headers: { Authorization: IZI_AUTH_TOKEN },
  });
  if (!resp.ok) return res.status(500).json({ error: "Erreur getQuizSummary " + resp.statusText });
  return res.status(200).json(await resp.json());
}

export async function getQuizResults(req: Request, res: Response) {
  try {
    const { responses } = req.body;
    const r = await fetch(IRENOV_API_URL, {
      method : "POST",
      headers: { "content-type": "application/json" },
      body   : JSON.stringify(responses),
    });
    if (!r.ok) throw new Error(r.statusText);
    return res.status(200).json(await r.json());
  } catch (e:any) {
    return res.status(500).json({ error: "Erreur getQuizResults " + e });
  }
}
