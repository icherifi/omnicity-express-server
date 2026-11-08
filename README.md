# Omnicity – API back-end

API Node.js/TypeScript d'Omnicity, une startup de services pour les courtiers immobiliers : scans 3D de logements, home staging virtuel par IA et dossiers de rénovation énergétique.

- **Scans iPhone (RoomPlan)** : lecture de la géométrie 3D (murs, ouvertures, mobilier) et découpage automatique du logement en zones (chambre, cuisine, salon…).
- **Home staging par agent IA** : Claude (tool calling) meuble chaque pièce avec de vrais modèles 3D. L'agent exprime des intentions (« contre ce mur ») et un solveur géométrique calcule les positions, puis valide les contraintes (collisions, portes, fenêtres, plafond).
- **Auto-vérification visuelle** : rendu headless du viewer Three.js via Playwright, renvoyé à l'agent pendant sa planification.
- **Rénovation énergétique** : DPE récupérés via l'API de l'ADEME, extraction structurée par LLM (OpenAI + Zod) et pré-remplissage des formulaires d'aides.

**Stack :** TypeScript · Node.js/Express · Supabase (PostgreSQL, Auth, Storage) · Three.js · API Claude · OpenAI · Playwright · Docker · Fly.io

## Lancer en local

```bash
cp .env.example .env   # renseigner les clés (jamais de secrets dans le code)
npm install
npm run dev            # http://localhost:6300
```
