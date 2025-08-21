import { Request, Response } from "express";
import { getValue, mapOccupancyStatusToLabel, mapFiscalIncomeToInterval } from "../../utils/form";
import { createIziSession as createIziSessionSvc, sendStepAnswer as sendStepIziAnswerSvc, getSessionResult } from "../../services/iziService";
import { getDpeData } from "../../services/dpeService";
import { mapDpeToFormData as mapDpeToFormDataSvc, extractDpeMetrics as extractDpeMetricsSvc } from "../../services/energyMappingService";

const IZI_API_URL = "https://qr.izi-by-edf.fr/api/socle/qr";
const IRENOV_API_URL = "https://api.irenov.izi-by-edf.fr/api/session";
const IZI_AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiJUZXN0IiwibmFtZSI6IlFSIFNlcnZpY2UiLCJpYXQiOjE1MTYyMzkyMzR9JngCUr2KcZHQ-AYl6esoTdE-t-cv6RfxvmbCBwaAItA";

type StepAnswer = { answer: number | number[] };

// Contexte mémoire pour chaque session IZI afin de pouvoir reprendre l'auto-complétion après intervention utilisateur
const sessionsContext = new Map<string, {
  completeFormData : Record<string, any>,
  dpeData          : any,
  fiscalIncome     : string,
  incomeQuestion   : any,
  packTravauxInfos : any,
}>();

/**
 * Parcourt les étapes IZI à partir d'un currentStep en essayant d'y répondre automatiquement.
 * S'arrête et retourne la première question sans réponse ou au format invalide.
 * @returns { nextQuestion?: any, lastStep?: any, incomeQuestion?: any }
 */
async function internalAutoFillLoop(currentStep: any, completeFormData: Record<string, any>) {
  let incomeQuestion: any = null;

  while (currentStep?.node?.question) {
    // Saut de la question sur les revenus
    if (currentStep.node.question.label === "Revenu annuel moyen de votre foyer fiscal") {
      incomeQuestion = currentStep.node.question;
      currentStep    = currentStep.nextStep;
      continue;
    }

    const qLabel = currentStep.node.question.label.replace(":", "").trim() as keyof typeof completeFormData;
    const answer = completeFormData[qLabel];

    if (!answer) {
      return { nextQuestion: currentStep.node.question, stepId: currentStep.id, incomeQuestion };
    }

    // Préparation du corps de réponse selon le type de question
    let answerBody: StepAnswer | null = null;
    if (currentStep.node.question.type === "QuestionChoice") {
      const choice = currentStep.node.question.choices?.find((c: any) => c.label === answer[0]);
      if (choice) answerBody = { answer: [choice.id] };
    } else if (currentStep.node.question.type === "QuestionInteger") {
      const val = parseFloat(Array.isArray(answer) ? answer[0] : answer);
      if (!isNaN(val)) answerBody = { answer: Math.round(val) };
    }

    if (!answerBody) {
      return { nextQuestion: currentStep.node.question, stepId: currentStep.id, incomeQuestion };
    }

    const stepData = await sendStepIziAnswerSvc(currentStep.id, answerBody);
    currentStep    = stepData.nextStep;
  }

  return { lastStep: currentStep, incomeQuestion };
}

export async function autoFillForm(req: Request, res: Response) {
  try {
    const { dpeNumber, fiscalIncome, householdSize, occupancyStatus } = req.body;
    if (!dpeNumber) return res.status(400).json({ error: "Le numéro de DPE est requis" });

    console.log("=== DÉBUT AUTO-FILL FORM ===");
    console.log("Données reçues:", { dpeNumber, fiscalIncome, householdSize, occupancyStatus });

    const { dpeData, rootXml } = await getDpeData(dpeNumber);

    let packTravauxInfos = null;
    const packTravauxCollection = rootXml.descriptif_travaux?.pack_travaux_collection?.pack_travaux;
    if (packTravauxCollection) {
      const packs = Array.isArray(packTravauxCollection) ? packTravauxCollection : [packTravauxCollection];
      const pack = packs[0];
      if (pack) {
        packTravauxInfos = {
          coutPackTravauxMin: pack.cout_pack_travaux_min ? Number(pack.cout_pack_travaux_min) : null,
          coutPackTravauxMax: pack.cout_pack_travaux_max ? Number(pack.cout_pack_travaux_max) : null,
          lots: [] as {
            enum_lot_travaux_id: any,
            description_travaux: any,
            performance_recommande: any
          }[],
        };
        const travauxCollection = pack.travaux_collection?.travaux;
        if (travauxCollection) {
          const travauxArr = Array.isArray(travauxCollection) ? travauxCollection : [travauxCollection];
          packTravauxInfos.lots = travauxArr.map(t => ({
            enum_lot_travaux_id: t.enum_lot_travaux_id ?? null,
            description_travaux: t.description_travaux ?? null,
            performance_recommande: t.performance_recommande ?? null,
          }));
        }
      }
    }

    const session      = (await createIziSessionSvc()) as any;
    let   currentStep  = session.currentStep;
    let   incomeQuestion: any = null;

    const formData = await mapDpeToFormDataSvc(dpeData);
    // Adapter le libellé du nombre d'habitants selon les choix IZI (1-6 ou « 7 et plus »)
    let householdLabel = householdSize;
    const hsNum = parseInt(String(householdSize ?? "").trim(), 10);
    if (!isNaN(hsNum) && hsNum >= 7) householdLabel = "7 et plus";

    const completeFormData = {
      ...formData,
      "Nombre d'habitants composant votre foyer fiscal": [String(householdLabel)],
      "Par rapport au logement, vous êtes ?"           : [mapOccupancyStatusToLabel(occupancyStatus)],
    };

    console.log("=== QUESTIONS AUTO-REMPLIES ===");
    Object.entries(completeFormData).forEach(([question, reponse]) => {
      console.log(`Question: \"${question}\"`);
      console.log(`Réponse: ${Array.isArray(reponse) ? reponse.join(", ") : reponse}`);
      console.log("---");
    });

    const pick = (label: keyof typeof formData) =>
      Array.isArray(formData[label]) ? formData[label][0] : formData[label];

    const periodeConstruction = pick("L'année de construction du logement");
    const typeGenerateur      = pick("Le type d'appareil de votre chauffage principal");
    const typeVentilation     = pick("Quel est le type de ventilation ?");
    const typeVitrage         = pick("Comment est le vitrage de vos fenêtres ?");
    const materiauxMenuiserie = pick("Quel est le matériau de vos fenêtres ?");
    const systemeEcs          = pick("Quel appareil produit votre eau chaude sanitaire ?");

    
    const { nextQuestion, stepId: pendingStepId, incomeQuestion: incQ } = await internalAutoFillLoop(currentStep, completeFormData);
    incomeQuestion = incQ;

    // Si une question nécessite l'intervention utilisateur, on renvoie immédiatement les infos nécessaires
    if (nextQuestion) {
      // Mémoriser le contexte pour la suite de la session
      sessionsContext.set(session.id, {
        completeFormData,
        dpeData,
        fiscalIncome,
        incomeQuestion,
        packTravauxInfos,
      });

      return res.status(200).json({
        sessionId     : session.id,
        nextQuestion  : {
          stepId  : pendingStepId,
          label   : nextQuestion.label,
          type    : nextQuestion.type,
          choices : nextQuestion.choices ?? [],
        },
      });
    }

    console.log("=== FIN AUTO-FILL FORM ===");

    const summaryData = (await getSessionResult(session.id)) as Record<string, any>;

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

    const metrics = extractDpeMetricsSvc(dpeData);

    const relevantDpeData = {
      numero_dpe: dpeNumber,
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
        total: metrics.costs.total,
      },

      conso: {
        conso5UsagesAvantTravaux      : metrics.conso.conso5UsagesAvantTravaux,
        emissionGes5UsagesAvantTravaux: metrics.conso.emissionGes5UsagesAvantTravaux,
      },

      travaux: {
        pack: {
          conso5UsagesApresTravaux      : metrics.travaux.conso5UsagesApresTravaux,
          emissionGes5UsagesApresTravaux: metrics.travaux.emissionGes5UsagesApresTravaux,
          ...(packTravauxInfos || {}),
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
  try   { return res.json(await createIziSessionSvc()); }
  catch (e:any) { return res.status(500).json({ error: e.message }); }
}

export async function sendStepIziAnswerHandler(req: Request, res: Response) {
  try {
    const { stepId, answer, sessionId } = req.body;
    if (!stepId || !answer || !sessionId) {
      return res.status(400).json({ error: "stepId, sessionId et answer sont requis" });
    }

    // envoyer la réponse de l'utilisateur à IZI
    const firstStepData = await sendStepIziAnswerSvc(stepId, { answer });
    let   currentStep   = firstStepData.nextStep;

    const ctx = sessionsContext.get(sessionId);
    if (!ctx) {
      // Contexte absent : renvoyer simplement la réponse IZI brute
      return res.json(firstStepData);
    }

    const { completeFormData, dpeData, fiscalIncome, incomeQuestion: storedIncomeQ, packTravauxInfos } = ctx;

    // Reprendre la boucle d'auto-complétion
    const { nextQuestion: nextQ2, stepId: pendingStepId2, incomeQuestion: incQ } = await internalAutoFillLoop(currentStep, completeFormData);

    const incomeQuestion = incQ || storedIncomeQ;

    // Si encore besoin de l'utilisateur → renvoyer la prochaine question
    if (nextQ2) {
      sessionsContext.set(sessionId, ctx); // Contexte inchangé, on garde
      return res.status(200).json({
        sessionId,
        nextQuestion: {
          stepId  : pendingStepId2,
          label   : nextQ2.label,
          type    : nextQ2.type,
          choices : nextQ2.choices ?? [],
        },
      });
    }

    // Plus aucune question : on finalize comme dans autoFillForm

    const summaryData = (await getSessionResult(sessionId)) as Record<string, any>;

    const responses: Record<string,any> = { ...completeFormData, ...summaryData };
    responses["Revenu annuel moyen de votre foyer fiscal"] = [
      mapFiscalIncomeToInterval(fiscalIncome, incomeQuestion?.choices || [])
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

    const metrics = extractDpeMetricsSvc(dpeData);

    const relevantDpeData = {
      numero_dpe: dpeData?.numero_dpe ?? "",
      codePostal         : getValue(dpeData.administratif, "code_postal_brut"),
      adresse            : getValue(dpeData.administratif, "label_brut"),
      periodeConstruction: completeFormData["L'année de construction du logement"]?.[0] ?? "",
      surfaceHabitable   : getValue(dpeData.logement,      "surface_habitable_logement"),
      typeGenerateur     : completeFormData["Le type d'appareil de votre chauffage principal"]?.[0] ?? "",
      typeVentilation    : completeFormData["Quel est le type de ventilation ?"]?.[0] ?? "",
      typeVitrage        : completeFormData["Comment est le vitrage de vos fenêtres ?"]?.[0] ?? "",
      materiauxMenuiserie: completeFormData["Quel est le matériau de vos fenêtres ?"]?.[0] ?? "",
      nombreNiveaux      : getValue(dpeData.logement,      "nombre_niveau_logement"),
      systemeEcs         : completeFormData["Quel appareil produit votre eau chaude sanitaire ?"]?.[0] ?? "",

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
          typeActuel: completeFormData["Quel est le type de ventilation ?"]?.[0] ?? "",
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
        total: metrics.costs.total,
      },

      conso: {
        conso5UsagesAvantTravaux      : metrics.conso.conso5UsagesAvantTravaux,
        emissionGes5UsagesAvantTravaux: metrics.conso.emissionGes5UsagesAvantTravaux,
      },

      travaux: {
        pack: {
          conso5UsagesApresTravaux      : metrics.travaux.conso5UsagesApresTravaux,
          emissionGes5UsagesApresTravaux: metrics.travaux.emissionGes5UsagesApresTravaux,
          ...(packTravauxInfos || {}),
        },
      },
    };

    // La session est terminée, on peut supprimer le contexte pour libérer la mémoire
    sessionsContext.delete(sessionId);

    return res.json({
      iziResponse: finalData,
      dpeData    : relevantDpeData,
      sessionId  : sessionId,
    });
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
