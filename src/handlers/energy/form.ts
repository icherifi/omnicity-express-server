import { Request, Response } from "express";
import { parseStringPromise } from 'xml2js';
import { getValue, mapPeriodeConstruction, mapTypeEnergie, mapTypeAppareilChauffage, isIleDeFrance, mapOccupancyStatusToLabel, mapTypeVitrageToLabel, mapMatMenuiserieToLabel, mapVentilationCodeToLabel, getValueByColumn, mapSystemeEcsToLabel, mapFiscalIncomeToInterval, getValues } from "../../utils/form";
import { DpeFormattedData } from "../../types/dpe.types";

const IZI_API_URL = "https://qr.izi-by-edf.fr/api/socle/qr";
const IRENOV_API_URL = "https://api.irenov.izi-by-edf.fr/api/session";
const IZI_AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiJUZXN0IiwibmFtZSI6IlFSIFNlcnZpY2UiLCJpYXQiOjE1MTYyMzkyMzR9JngCUr2KcZHQ-AYl6esoTdE-t-cv6RfxvmbCBwaAItA";

async function createIziSession(): Promise<any> {
  const resp = await fetch(`${IZI_API_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": IZI_AUTH_TOKEN },
    body: JSON.stringify({ slug: "simulation-renovation-energetique" }),
  });
  
  if (!resp.ok) {
    throw new Error(`Erreur création session: ${resp.status}`);
  }
  
  return resp.json();
}

async function sendStepIziAnswer(stepId: string, answerBody: StepAnswer): Promise<StepResponse> {
  const resp = await fetch(`${IZI_API_URL}/steps/${stepId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/merge-patch+json",
      Authorization: IZI_AUTH_TOKEN,
    },
    body: JSON.stringify(answerBody),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Erreur lors de l'envoi de la réponse: ${resp.status} - ${errorText}`);
  }

  return resp.json();
}

export async function createIziSessionHandler(req: Request, res: Response) {
  try {
    const data = await createIziSession();
    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
}

export async function sendStepIziAnswerHandler(req: Request, res: Response) {
  try {
    const { stepId, answer } = req.body;
    if (!stepId || !answer) {
      return res.status(400).json({ error: "stepId et answer sont requis" });
    }

    const data = await sendStepIziAnswer(stepId, { answer });
    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
}

  
export async function getQuizSummary(req: Request, res: Response) {
  const { sessionId } = req.params;
  const resp = await fetch(`https://qr.izi-by-edf.fr/api/socle/qr/sessions/${sessionId}/result`, {
    headers: {
      Authorization: IZI_AUTH_TOKEN,
    },
  });
  if (!resp.ok) return res.status(500).json({ error: "Erreur getQuizSummary " + resp.statusText });

  const data = await resp.json();
  return res.status(200).json(data);
}

export async function getQuizResults(req: Request, res: Response) {
  const { responses } = req.body;
  
  try {
    const response = await fetch(
      "https://api.irenov.izi-by-edf.fr/api/session",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",     
        },
        body: JSON.stringify(responses),
      }
    );

    if (!response.ok) throw new Error(response.statusText);

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: "Erreur getQuizResults " + error });
  }
}

function mapDpeToFormData(dpeData: DpeData): DpeFormattedData {
  const logementRows = dpeData?.logement || [];
  const administratifRows = dpeData?.administratif || [];
  const rapportRows = dpeData?.rapport || [];

  const codePostal = getValue(administratifRows, "code_postal_brut") || "";
  const periodeConst = getValue(logementRows, "periode_construction") || getValue(logementRows, "enum_periode_construction_id");
  const surfaceHabLog = getValue(logementRows, "surface_habitable_logement") || "";
  const typeGenerateur = getValue(logementRows, "type_generateur_ch") || getValue(logementRows, "enum_type_generateur_ch_id") || getValue(logementRows, "enum_type_energie_id");
  const typeVentilation = getValue(logementRows, "type_ventilation") || getValue(logementRows, "enum_type_ventilation_id");
  const typeVitrage = getValue(logementRows, "type_vitrage") || getValue(logementRows, "enum_type_vitrage_id") || "";
  const matMenuiserie = getValue(logementRows, "type_materiaux_menuiserie") || getValue(logementRows, "enum_type_materiaux_menuiserie_id") || "";
  const nbNiveaux = getValue(logementRows, "nombre_niveau_logement") || "";

  const systemeEcs = getValueByColumn(rapportRows, "système d'ecs", 1, 2) || "";

  return {
    "L'année de construction du logement": [mapPeriodeConstruction(periodeConst)],
    "La maison est-elle mitoyenne ?": ["Non"],
    "Le nombre de niveaux habités": [nbNiveaux],
    "Le type d'appareil de votre chauffage principal": [mapTypeAppareilChauffage(typeGenerateur)],
    "Le type de toiture": ["Combles perdus"],
    "Possédez-vous un second type de chauffage ?": ["Non"],
    "Quel appareil produit votre eau chaude sanitaire ?": [mapSystemeEcsToLabel(systemeEcs || "")],
    "Quel est le matériau de vos fenêtres ?": [mapMatMenuiserieToLabel(matMenuiserie)],
    "Quel est le type de ventilation ?": [mapVentilationCodeToLabel(typeVentilation || "VMC SF hygro B")],
    "Quel est votre type de planchers bas ?": ["Cave ou sous-sol"],
    "Quelle est la source d'énergie de chauffage principale ?": [mapTypeEnergie(typeGenerateur)],
    "Sa forme": ["Rectangulaire compacte"],
    "Sa surface habitable (m²)": surfaceHabLog,
    "Vous habitez": [isIleDeFrance(codePostal)],
    "Avez-vous déjà effectué des travaux d'isolation de vos murs ?": ["Je ne sais pas"],
    "Avez-vous déjà effectué des travaux d'isolation de votre toiture ?": ["Je ne sais pas"],
    "Avez-vous déjà effectué des travaux d'isolation de vos planchers bas ?": ["Je ne sais pas"],
    "Code Postal": codePostal,
    "Comment est le vitrage de vos fenêtres ?": [mapTypeVitrageToLabel(typeVitrage)]
  };
}
interface DpeData {
  [key: string]: any[];
  logement: any[];
  logement_sortie: any[];
  administratif: any[];
  rapport: any[];
  lexique: any[];
}

interface StepResponse {
  nextStep: {
    id: string;
    node: {
      question: {
        label: string;
        type: string;
        choices?: Array<{
          id: string;
          label: string;
        }>;
      };
    };
  };
}

interface StepAnswer {
  answer: number | number[];
}

export async function autoFillForm(req: Request, res: Response) {
  try {
    const { dpeNumber, fiscalIncome, householdSize, occupancyStatus } = req.body;
    
    if (!dpeNumber) {
      return res.status(400).json({ error: 'Le numéro de DPE est requis' });
    }

    const dpeResp = await fetch(`https://prd-x-ademe-externe-api.de-c1.eu1.cloudhub.io/api/v1/pub/dpe/${dpeNumber}/xml`, {
      headers: {
        'client_id': 'f15319ce605e407581242b71425bbcb6',
        'client_secret': '4d97b25a303b412eB968C26Aef30D933',
        'Content-Type': 'application/json'
      }
    });
    if (!dpeResp.ok) {
      throw new Error(`Erreur lors de la récupération du DPE: ${dpeResp.statusText}`);
    }

    const xmlText = await dpeResp.text();

    const parsedXml: any = await parseStringPromise(xmlText, {
      explicitArray: false,
      mergeAttrs: true,
    });

    const sheets = [
      'administratif',
      'logement',
      'logement_sortie',
      'rapport',
      'lexique',
    ];

    const dpeData: DpeData = {
      logement: [],
      logement_sortie: [],
      administratif: [],
      rapport: [],
      lexique: [],
    };

    function flattenObjectToRows(
      obj: any,
      rows: any[][],
      addEmptyFirstCol = false,
    ) {
      if (!obj) return;
      Object.entries(obj).forEach(([key, value]) => {
        if (value === null || value === undefined) return;
        if (typeof value === 'object') {
          flattenObjectToRows(value, rows, addEmptyFirstCol);
        } else {
          if (addEmptyFirstCol) {
            rows.push(['', key, String(value)]);
          } else {
            rows.push([key, String(value)]);
          }
        }
      });
    }

    for (const sheet of sheets) {
      const section = (parsedXml?.dpe && (parsedXml.dpe as any)[sheet]) || parsedXml[sheet];
      if (section) {
        const rows: any[][] = [];
        flattenObjectToRows(section, rows, sheet === 'rapport');
        dpeData[sheet as keyof DpeData] = rows;
      }
    }

    const sessionData = await createIziSession();
    const sessionId = sessionData.id;
    let currentStep = sessionData.currentStep;
    let incomeQuestion: any = null;

    const formData = mapDpeToFormData(dpeData);
    const completeFormData = {
      ...formData,
      "Nombre d'habitants composant votre foyer fiscal": [householdSize],
      "Par rapport au logement, vous êtes ?": [mapOccupancyStatusToLabel(occupancyStatus)]
    };

    while (currentStep && currentStep.node && currentStep.node.question) {
      if (currentStep.node.question.label === "Revenu annuel moyen de votre foyer fiscal") {
        incomeQuestion = currentStep.node.question;
        currentStep = currentStep.nextStep;
        continue;
      }

      const questionLabel = currentStep.node.question.label.replace(':', '').trim();
      const answer = completeFormData[questionLabel as keyof typeof completeFormData];

      if (!answer) {
        console.warn(`Pas de réponse trouvée pour la question: ${questionLabel}`);
        break;
      }

      let answerBody: StepAnswer | null = null;

      if (currentStep.node.question.type === "QuestionChoice") {
        const matchingChoice = currentStep.node.question.choices.find(
          (choice: any) => choice.label === answer[0]
        );
        if (matchingChoice) {
          answerBody = { answer: [matchingChoice.id] };
        }
      } else if (currentStep.node.question.type === "QuestionInteger") {
        const numericValue = parseFloat(Array.isArray(answer) ? answer[0] : answer);
        if (!isNaN(numericValue)) {
          answerBody = { answer: Math.round(numericValue) };
        }
      }

      if (!answerBody) {
        console.warn(`Pas de réponse valide pour la question: ${questionLabel}`);
        break;
      }

      const stepData = await sendStepIziAnswer(currentStep.id, answerBody);
      currentStep = stepData.nextStep;
    }

    const summaryResp = await fetch(`${IZI_API_URL}/sessions/${sessionId}/result`, {
      headers: { "Authorization": IZI_AUTH_TOKEN },
    });
    if (!summaryResp.ok) {
      throw new Error(`Erreur lors de la récupération du résumé: ${summaryResp.status}`);
    }

    const summaryData = await summaryResp.json();
    const responses = {
      ...summaryData,
      "Code Postal": completeFormData["Code Postal"],
      "Revenu annuel moyen de votre foyer fiscal": [mapFiscalIncomeToInterval(fiscalIncome, incomeQuestion?.choices || [])]
    };

    const iRenovResp = await fetch(IRENOV_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain",
        "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      body: JSON.stringify(responses),
    });

    if (!iRenovResp.ok) {
      const errorText = await iRenovResp.text();
      throw new Error(`Erreur API iRenov: ${iRenovResp.status} - ${errorText}`);
    }

    const finalData = await iRenovResp.json();
    const metrics = extractDpeMetrics(dpeData);

    const relevantDpeData = {
      codePostal: getValue(dpeData.administratif, "code_postal_brut"),
      adresse: getValue(dpeData.administratif, "label_brut"),
      periodeConstruction: getValue(dpeData.logement, "periode_construction"),
      surfaceHabitable: getValue(dpeData.logement, "surface_habitable_logement"),
      typeGenerateur: getValue(dpeData.logement, "type_generateur_ch"),
      typeVentilation: getValue(dpeData.logement, "type_ventilation"),
      typeVitrage: getValue(dpeData.logement, "type_vitrage"),
      materiauxMenuiserie: getValue(dpeData.logement, "type_materiaux_menuiserie"),
      nombreNiveaux: getValue(dpeData.logement, "nombre_niveau_logement"),
      systemeEcs: getValueByColumn(dpeData.rapport, "système d'ecs", 1, 2),
      caracteristiques: {
        taille: Math.round(Number(getValue(dpeData.logement, "surface_habitable_logement"))).toString(),
        nombrePieces: 0,
        nombreEtages: Number(getValue(dpeData.logement, "nombre_niveau_logement")),
      },
      quantites: {
        murs: {
          surfaces: metrics.wallSurfaces,
          total: metrics.totalWallSurface,
        },
        fenetres: {
          nombre: metrics.nbBays,
          surface: metrics.totalBaySurface,
        },
        portes: {
          surface: metrics.doorSurface || 0,
        },
        ventilation: {
          typeActuel: getValue(dpeData.logement, 'type_ventilation'),
          surface: metrics.ventilatedSurface,
        },
        chauffage: {
          besoinKWh: metrics.heatingNeed,
          perteWK: metrics.heatLossRate,
        },
      },
      couts: {
        chauffage: metrics.costs.heating,
        ecs: metrics.costs.ecs,
        eclairage: metrics.costs.lighting,
        auxiliaires: metrics.costs.aux,
        autres: (Number(metrics.costs.lighting) + Number(metrics.costs.aux)).toString(),
        total: (Number(metrics.costs.heating) + Number(metrics.costs.ecs) + Number(metrics.costs.lighting) + Number(metrics.costs.aux)).toString(),
      },
      travaux: {
        pack: {
          conso5UsagesApresTravaux: metrics.travaux.conso5UsagesApresTravaux,
          emissionGes5UsagesApresTravaux: metrics.travaux.emissionGes5UsagesApresTravaux,
        },
      }
    };

    return res.status(200).json({
      iziResponse: finalData,
      dpeData: relevantDpeData,
      sessionId: sessionId
    });
  } catch (error: any) {
    console.error('Erreur détaillée:', error);
    return res.status(500).json({ 
      error: 'Erreur lors du remplissage automatique du formulaire', 
      details: error.message 
    });
  }
}

function extractDpeMetrics(data: DpeData) {
  const logementRows = data?.logement || [];
  const logementSortieRows = data?.logement_sortie || [];
  const rapportRows = data?.rapport || [];

  const wallSurfaces = getValues(logementRows, 'surface_paroi_opaque').map(Number);
  const totalWallSurface = wallSurfaces.reduce((s, n) => s + n, 0);

  const baySurfaces = getValues(logementRows, 'surface_totale_baie').map(Number);
  const totalBaySurface = baySurfaces.reduce((s, n) => s + n, 0);
  const nbBays = getValues(logementRows, 'nb_baie').map(Number).reduce((s, n) => s + n, 0);

  return {
    wallSurfaces,
    totalWallSurface,
    baySurfaces,
    totalBaySurface,
    nbBays,
    ventilatedSurface: Number(getValue(logementRows, 'surface_ventile')),
    heatingNeed: Number(getValue(logementSortieRows, 'besoin_ch')),
    heatLossRate: Number(getValue(logementSortieRows, 'deperdition_enveloppe')),
    doorSurface: Number(getValue(logementRows, 'surface_porte')),
    costs: {
      heating: getValue(logementSortieRows, 'cout_ch'),
      ecs: getValue(logementSortieRows, 'cout_ecs'),
      lighting: getValue(logementSortieRows, 'cout_eclairage'),
      aux: getValue(logementSortieRows, 'cout_total_auxiliaire'),
    },
    travaux: {
      conso5UsagesApresTravaux: getValue(rapportRows, 'conso_5_usages_apres_travaux'),
      emissionGes5UsagesApresTravaux: getValue(rapportRows, 'emission_ges_5_usages_apres_travaux'),
    }
  };
}