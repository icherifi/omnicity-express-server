const IZI_API_URL = "https://qr.izi-by-edf.fr/api/socle/qr";
const IZI_AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiJUZXN0IiwibmFtZSI6IlFSIFNlcnZpY2UiLCJpYXQiOjE1MTYyMzkyMzR9JngCUr2KcZHQ-AYl6esoTdE-t-cv6RfxvmbCBwaAItA";

interface StepAnswer { answer: number | number[]; }
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

async function createIziSession(): Promise<any> {
  const resp = await fetch(`${IZI_API_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: IZI_AUTH_TOKEN },
    body: JSON.stringify({ slug: "simulation-renovation-energetique" }),
  });
  if (!resp.ok) throw new Error(`Erreur création session: ${resp.status}`);
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

function normalizeLabel(str: string) {
  return str
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove accents
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")   // remove punctuation
    .replace(/\s+/g, " ")
    .trim();
}

const targetLabels = {
  chauffage  : normalizeLabel("le type d'appareil de votre chauffage principal"),
  eauChaude  : normalizeLabel("quel appareil produit votre eau chaude sanitaire"),
  ventilation: normalizeLabel("quel est le type de ventilation"),
  energie    : normalizeLabel("quelle est la source d'energie de chauffage principale"),
  secondHeat : normalizeLabel("possédez-vous un second type de chauffage"),
  mitoyenne  : normalizeLabel("la maison est-elle mitoyenne"),
  toiture    : normalizeLabel("le type de toiture"),
  planchers  : normalizeLabel("quel est votre type de planchers bas"),
  forme      : normalizeLabel("sa forme"),
  isolationMurs: normalizeLabel("avez-vous déjà effectué des travaux d'isolation de vos murs"),
  isolationToiture: normalizeLabel("avez-vous déjà effectué des travaux d'isolation de votre toiture"),
  isolationPlanchers: normalizeLabel("avez-vous déjà effectué des travaux d'isolation de vos planchers bas"),
};

function isChauffageQuestion(label: string) {
  return normalizeLabel(label).includes(targetLabels.chauffage);
}
function isEauChaudeQuestion(label: string) {
  return normalizeLabel(label).includes(targetLabels.eauChaude);
}
function isVentilationQuestion(label: string) {
  return normalizeLabel(label).includes(targetLabels.ventilation);
}
function isEnergieQuestion(label: string) {
  return normalizeLabel(label).includes(targetLabels.energie);
}
function isSecondHeatingQuestion(label: string) {
  return normalizeLabel(label).includes(targetLabels.secondHeat);
}
function isMitoyenneQuestion(label: string) {
  return normalizeLabel(label).includes(targetLabels.mitoyenne);
}
function isToitureQuestion(label: string) {
  return normalizeLabel(label).includes(targetLabels.toiture);
}
function isPlanchersQuestion(label: string) {
  return normalizeLabel(label).includes(targetLabels.planchers);
}
function isFormeQuestion(label: string) {
  return normalizeLabel(label).includes(targetLabels.forme);
}
function isIsolationMursQuestion(label: string) {
  return normalizeLabel(label).includes(targetLabels.isolationMurs);
}
function isIsolationToitureQuestion(label: string) {
  return normalizeLabel(label).includes(targetLabels.isolationToiture);
}
function isIsolationPlanchersQuestion(label: string) {
  return normalizeLabel(label).includes(targetLabels.isolationPlanchers);
}

async function remplirFormulaireEtCollecter(): Promise<{
  sessionId: string;
  timestamp: string;
  // Choix disponibles (tous) pour chaque question d'intérêt
  chauffage_choices_available: string[];
  eau_chaude_choices_available: string[];
  ventilation_choices_available: string[];
  energie_choices_available: string[];
  // Choix effectivement sélectionnés
  chauffage_choice_selected: string | null;
  eau_chaude_choice_selected: string | null;
  ventilation_choice_selected: string | null;
  energie_choice_selected: string | null;
  all_questions: string[];
}> {
  const session = await createIziSession();
  let currentStep = session.currentStep;
  let stepCount = 0;
  // --- Disponibles ---
  let chauffageChoicesAvail: string[] = [];
  let eauChaudeChoicesAvail: string[] = [];
  let ventilationChoicesAvail: string[] = [];
  let energieChoicesAvail: string[] = [];
  // --- Sélectionnés ---
  let chauffageChoiceSel: string | null = null;
  let eauChaudeChoiceSel: string | null = null;
  let ventilationChoiceSel: string | null = null;
  let energieChoiceSel: string | null = null;
  let allQuestions: string[] = [];

  while (currentStep?.node?.question) {
    const question = currentStep.node.question;
    const label = question.label;
    
    console.log(`\n📍 Question ${stepCount + 1}: "${label}"`);
    console.log(`   Type: ${question.type}`);
    
    // Enregistrer toutes les questions
    allQuestions.push(label);
    
    // Si question d'intérêt, stocker tous les choix possibles
    if (question.choices && question.choices.length > 0) {
      console.log(`   Choix disponibles (${question.choices.length}):`);
      question.choices.forEach((c: { id: string; label: string }, idx: number) => {
        console.log(`     ${idx + 1}. ${c.label} (ID: ${c.id})`);
      });
      
      // Gestion spéciale : question "second type de chauffage" => toujours "Non"
      if (isSecondHeatingQuestion(label)) {
        const nonChoice = question.choices.find((c: { label: string }) => normalizeLabel(c.label) === 'non');
        if (nonChoice) {
          const answer = [nonChoice.id];
          console.log(`   → Réponse forcée (second chauffage): ${nonChoice.label}`);
          try {
            const response = await sendStepIziAnswer(currentStep.id, { answer });
            currentStep = response.nextStep;
            console.log(`   ✅ Réponse envoyée avec succès (second chauffage)`);
            await new Promise(res => setTimeout(res, 100));
          } catch (e) {
            console.error(`   ❌ Erreur lors de l'envoi de la réponse (second chauffage):`, e);
            break;
          }
          stepCount++;
          continue; // passer à la question suivante
        }
      }

      // Gestion spéciale : question "mitoyenne" => toujours "Non"
      if (isMitoyenneQuestion(label)) {
        const nonChoice = question.choices.find((c: { label: string }) => normalizeLabel(c.label) === 'non');
        if (nonChoice) {
          const answer = [nonChoice.id];
          console.log(`   → Réponse forcée (mitoyenne): ${nonChoice.label}`);
          try {
            const response = await sendStepIziAnswer(currentStep.id, { answer });
            currentStep = response.nextStep;
            console.log(`   ✅ Réponse envoyée avec succès (mitoyenne)`);
            await new Promise(res => setTimeout(res, 100));
          } catch (e) {
            console.error(`   ❌ Erreur lors de l'envoi de la réponse (mitoyenne):`, e);
            break;
          }
          stepCount++;
          continue;
        }
      }

      // Gestion spéciale : question "toiture" => toujours "Combles perdus"
      if (isToitureQuestion(label)) {
        const comblesPerdusChoice = question.choices.find((c: { label: string }) => 
          normalizeLabel(c.label).includes('combles perdus'));
        if (comblesPerdusChoice) {
          const answer = [comblesPerdusChoice.id];
          console.log(`   → Réponse forcée (toiture): ${comblesPerdusChoice.label}`);
          try {
            const response = await sendStepIziAnswer(currentStep.id, { answer });
            currentStep = response.nextStep;
            console.log(`   ✅ Réponse envoyée avec succès (toiture)`);
            await new Promise(res => setTimeout(res, 100));
          } catch (e) {
            console.error(`   ❌ Erreur lors de l'envoi de la réponse (toiture):`, e);
            break;
          }
          stepCount++;
          continue;
        }
      }

      // Gestion spéciale : question "planchers bas" => toujours "Cave ou sous-sol"
      if (isPlanchersQuestion(label)) {
        const caveChoice = question.choices.find((c: { label: string }) => 
          normalizeLabel(c.label).includes('cave') || normalizeLabel(c.label).includes('sous-sol'));
        if (caveChoice) {
          const answer = [caveChoice.id];
          console.log(`   → Réponse forcée (planchers): ${caveChoice.label}`);
          try {
            const response = await sendStepIziAnswer(currentStep.id, { answer });
            currentStep = response.nextStep;
            console.log(`   ✅ Réponse envoyée avec succès (planchers)`);
            await new Promise(res => setTimeout(res, 100));
          } catch (e) {
            console.error(`   ❌ Erreur lors de l'envoi de la réponse (planchers):`, e);
            break;
          }
          stepCount++;
          continue;
        }
      }

      // Gestion spéciale : question "forme" => toujours "Rectangulaire compacte"
      if (isFormeQuestion(label)) {
        const rectCompactChoice = question.choices.find((c: { label: string }) => 
          normalizeLabel(c.label).includes('rectangulaire compacte'));
        if (rectCompactChoice) {
          const answer = [rectCompactChoice.id];
          console.log(`   → Réponse forcée (forme): ${rectCompactChoice.label}`);
          try {
            const response = await sendStepIziAnswer(currentStep.id, { answer });
            currentStep = response.nextStep;
            console.log(`   ✅ Réponse envoyée avec succès (forme)`);
            await new Promise(res => setTimeout(res, 100));
          } catch (e) {
            console.error(`   ❌ Erreur lors de l'envoi de la réponse (forme):`, e);
            break;
          }
          stepCount++;
          continue;
        }
      }

      // Gestion spéciale : questions d'isolation => toujours "Je ne sais pas"
      if (isIsolationMursQuestion(label) || isIsolationToitureQuestion(label) || isIsolationPlanchersQuestion(label)) {
        const jeNeSaisPasChoice = question.choices.find((c: { label: string }) => 
          normalizeLabel(c.label).includes('je ne sais pas'));
        if (jeNeSaisPasChoice) {
          const answer = [jeNeSaisPasChoice.id];
          const questionType = isIsolationMursQuestion(label) ? 'isolation murs' : 
                              isIsolationToitureQuestion(label) ? 'isolation toiture' : 'isolation planchers';
          console.log(`   → Réponse forcée (${questionType}): ${jeNeSaisPasChoice.label}`);
          try {
            const response = await sendStepIziAnswer(currentStep.id, { answer });
            currentStep = response.nextStep;
            console.log(`   ✅ Réponse envoyée avec succès (${questionType})`);
            await new Promise(res => setTimeout(res, 100));
          } catch (e) {
            console.error(`   ❌ Erreur lors de l'envoi de la réponse (${questionType}):`, e);
            break;
          }
          stepCount++;
          continue;
        }
      }
      
      // Choix aléatoire pour continuer
      const randomIdx = Math.floor(Math.random() * question.choices.length);
      const randomChoice = question.choices[randomIdx];
      const answer = Array.isArray(randomChoice.id) ? randomChoice.id : [randomChoice.id];
      
      console.log(`   → Réponse choisie: ${randomChoice.label} (ID: ${randomChoice.id})`);
      
      // Stocker le choix sélectionné *et* tous les choix disponibles pour les questions d'intérêt
      if (isChauffageQuestion(label)) {
        chauffageChoicesAvail = question.choices.map((c: { label: string }) => c.label);
        chauffageChoiceSel = randomChoice.label;
        console.log(`   🔥 Question chauffage détectée !`);
      } else if (isEauChaudeQuestion(label)) {
        eauChaudeChoicesAvail = question.choices.map((c: { label: string }) => c.label);
        eauChaudeChoiceSel = randomChoice.label;
        console.log(`   🚿 Question eau chaude détectée !`);
      } else if (isVentilationQuestion(label)) {
        ventilationChoicesAvail = question.choices.map((c: { label: string }) => c.label);
        ventilationChoiceSel = randomChoice.label;
        console.log(`   💨 Question ventilation détectée !`);
      } else if (isEnergieQuestion(label)) {
        energieChoicesAvail = question.choices.map((c: { label: string }) => c.label);
        energieChoiceSel = randomChoice.label;
        console.log(`   ⚡ Question énergie détectée !`);
      }
      
      try {
        const response = await sendStepIziAnswer(currentStep.id, { answer });
        currentStep = response.nextStep;
        console.log(`   ✅ Réponse envoyée avec succès`);
        await new Promise(res => setTimeout(res, 100));
      } catch (e) {
        console.error(`   ❌ Erreur lors de l'envoi de la réponse:`, e);
        break;
      }
    } else if (question.type === "QuestionInteger") {
      console.log(`   Type entier détecté`);
      
      // Pour la surface habitable, utiliser une valeur entre 35 et 100
      let randomInt: number;
      if (label.toLowerCase().includes('surface') || label.toLowerCase().includes('m²')) {
        randomInt = Math.floor(Math.random() * 66) + 35; // 35-100 m² inclus
        console.log(`   → Surface détectée, valeur choisie: ${randomInt} m²`);
      } else {
        randomInt = Math.floor(Math.random() * 100) + 1;
        console.log(`   → Valeur entière choisie: ${randomInt}`);
      }
      
      try {
        const response = await sendStepIziAnswer(currentStep.id, { answer: randomInt });
        currentStep = response.nextStep;
        console.log(`   ✅ Réponse entière envoyée avec succès`);
        await new Promise(res => setTimeout(res, 100));
      } catch (e) {
        console.error(`   ❌ Erreur lors de l'envoi de la réponse entière:`, e);
        break;
      }
    } else {
      console.log(`   ⚠️ Type de question non géré: ${question.type}`);
      console.log(`   → Arrêt du formulaire`);
      break;
    }
    stepCount++;
  }
  
  if (!currentStep?.node?.question) {
    console.log(`\n🏁 Fin du formulaire atteinte après ${stepCount} questions`);
  }
  return {
    sessionId: session.id,
    timestamp: new Date().toISOString(),
    // Choix disponibles (tous) pour chaque question d'intérêt
    chauffage_choices_available: chauffageChoicesAvail,
    eau_chaude_choices_available: eauChaudeChoicesAvail,
    ventilation_choices_available: ventilationChoicesAvail,
    energie_choices_available: energieChoicesAvail,
    // Choix effectivement sélectionnés
    chauffage_choice_selected: chauffageChoiceSel,
    eau_chaude_choice_selected: eauChaudeChoiceSel,
    ventilation_choice_selected: ventilationChoiceSel,
    energie_choice_selected: energieChoiceSel,
    all_questions: allQuestions
  };
}

async function main(nbFormulaires = 10) {
  const results: any[] = [];
  for (let i = 0; i < nbFormulaires; i++) {
    console.log(`\n--- Remplissage du formulaire ${i + 1} ---`);
    try {
      const res = await remplirFormulaireEtCollecter();
      results.push(res);
      // Affichage résumé pour ce formulaire
      console.log(`Session: ${res.sessionId}`);
      console.log(`  Chauffage: ${res.chauffage_choice_selected || 'Non rencontré'}`);
      console.log(`  Eau chaude: ${res.eau_chaude_choice_selected || 'Non rencontré'}`);
      console.log(`  Ventilation: ${res.ventilation_choice_selected || 'Non rencontré'}`);
      console.log(`  Énergie: ${res.energie_choice_selected || 'Non rencontré'}`);
      res.all_questions.forEach((q, idx) => console.log(`    ${idx + 1}. ${q}`));
    } catch (e) {
      console.error("Erreur lors du remplissage d'un formulaire", e);
    }
  }
  
  // Regrouper tous les choix uniques pour chaque question d'intérêt
  const allChauffageChoices = new Set<string>();
  const allEauChaudeChoices = new Set<string>();
  const allVentilationChoices = new Set<string>();
  const allEnergieChoices = new Set<string>();
  const energieCounts = new Map<string, number>();
  
  results.forEach(res => {
    // Union de tous les choix proposés
    res.chauffage_choices_available.forEach((c: string) => allChauffageChoices.add(c));
    res.eau_chaude_choices_available.forEach((c: string) => allEauChaudeChoices.add(c));
    res.ventilation_choices_available.forEach((c: string) => allVentilationChoices.add(c));
    res.energie_choices_available.forEach((c: string) => allEnergieChoices.add(c));

    // Comptage basé sur la réponse sélectionnée
    if (res.energie_choice_selected) {
      energieCounts.set(res.energie_choice_selected, (energieCounts.get(res.energie_choice_selected) || 0) + 1);
    }
  });
  
  console.log(`\n✅ Exploration terminée. ${results.length} formulaires remplis.`);
  console.log(`\n📊 RÉSUMÉ GLOBAL - TOUS LES CHOIX POSSIBLES:`);
  console.log(`🔥 Chauffage (${allChauffageChoices.size} choix): ${Array.from(allChauffageChoices).join(' | ')}`);
  console.log(`🚿 Eau chaude (${allEauChaudeChoices.size} choix): ${Array.from(allEauChaudeChoices).join(' | ')}`);
  console.log(`💨 Ventilation (${allVentilationChoices.size} choix): ${Array.from(allVentilationChoices).join(' | ')}`);
  console.log(`⚡ Énergie (${allEnergieChoices.size} choix): ${Array.from(allEnergieChoices).join(' | ')}`);
  console.log(`\n📈 COMPTAGE DES RÉPONSES ÉNERGIE:`);
  Array.from(energieCounts.entries())
    .sort((a, b) => b[1] - a[1]) // Trier par nombre décroissant
    .forEach(([choice, count]) => {
      console.log(`   "${choice}": ${count} fois`);
    });
}

// Aucune exécution automatique. Utilisez main() depuis run.ts ou un autre script.

export { main, remplirFormulaireEtCollecter };
