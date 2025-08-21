import { main } from "./izi-form";

async function runExploration() {
  console.log("🔍 Démarrage de l'exploration du formulaire IZI...");
  
  try {
    await main(100); // 10 formulaires
    console.log("✅ Exploration terminée avec succès");
  } catch (error) {
    console.error("❌ Erreur lors de l'exploration:", error);
  }
}

runExploration();
