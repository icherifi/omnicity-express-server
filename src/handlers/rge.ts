import { Request, Response } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

interface AiRgeParams {
  q: string;
  code_postal?: string;
  commune?: string;
  domaine?: string;
  nom_entreprise?: string;
  nom_qualification?: string;
  organisme?: string;
  telephone?: string;
  siret?: string;
  meta_domaine?: string;
  adresse?: string;
  email?: string;
  [key: string]: any;
}

const RGE_DATASET_URL =
  "https://data.ademe.fr/data-fair/api/v1/datasets/liste-des-entreprises-rge-2/lines";

function buildSearchParams(params: AiRgeParams, start = 0, size = 20) {
  const urlParams = new URLSearchParams();
  
  // Utilisation des filtres _eq pour tous les champs spécifiques
  if (params.domaine) {
    urlParams.append("domaine_eq", params.domaine);
  }
  
  if (params.nom_entreprise) {
    urlParams.append("nom_entreprise_eq", params.nom_entreprise);
  }
  
  if (params.nom_qualification) {
    urlParams.append("nom_qualification_eq", params.nom_qualification);
  }
  
  if (params.organisme) {
    urlParams.append("organisme_eq", params.organisme);
  }
  
  if (params.meta_domaine) {
    urlParams.append("meta_domaine_eq", params.meta_domaine);
  }
  
  if (params.adresse) {
    urlParams.append("adresse_eq", params.adresse);
  }
  
  if (params.email) {
    urlParams.append("email_eq", params.email);
  }
  
  if (params.telephone) {
    urlParams.append("telephone_eq", params.telephone);
  }
  
  if (params.code_postal) {
    urlParams.append("code_postal_eq", params.code_postal);
  }
  
  if (params.commune) {
    urlParams.append("commune_eq", params.commune.toUpperCase());
  }
  
  if (params.siret) {
    urlParams.append("siret_eq", params.siret);
  }
  
  if (params.q && Object.keys(params).filter(k => k !== 'q').every(k => !params[k])) {
    urlParams.append("q", params.q);
  }
  
  Object.entries(params)
    .filter(([k]) => k.endsWith("_eq"))
    .forEach(([k, v]) => {
      urlParams.append(k, String(v));
    });

  urlParams.append("start", String(start));
  urlParams.append("size", String(size));
  return urlParams.toString();
}

async function parseQueryWithAI(query: string): Promise<AiRgeParams> {
  const systemPrompt = `Vous êtes un assistant qui convertit une requête de recherche naturelle (français) en paramètres pour l'API Datafair "Liste des entreprises RGE".

RÈGLES IMPORTANTES :
- Utilisez "q" UNIQUEMENT pour des termes généraux de recherche textuelle
- Pour les filtres spécifiques, utilisez les clés exactes correspondant aux colonnes de la base de données
- Préférez les filtres spécifiques plutôt que "q" quand c'est possible
- Les domaines d'activité doivent avoir la première lettre en majuscule (ex: "Architecte", "Électricien", "Plombier")

EXEMPLES :
- "architecte paris" → {"domaine": "Architecte", "commune": "paris"}
- "électricien 75001" → {"domaine": "Électricien", "code_postal": "75001"}
- "entreprise ABC" → {"nom_entreprise": "ABC"}
- "chauffage isolation" → {"q": "chauffage isolation"} (terme général)
- "qualification RGE" → {"nom_qualification": "RGE"}

Clés disponibles : code_postal, commune, domaine, nom_entreprise, nom_qualification, organisme, telephone, siret, meta_domaine, adresse, email.

Retournez un JSON STRICT sans commentaire. Ne renvoyez pas de clés vides.`;

  const userPrompt = `Requête: "${query}". Réponds uniquement par un JSON.`;
  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    });
    const content = completion.choices[0].message.content;
    console.log("content", content);
    if (!content) throw new Error("Réponse vide d'OpenAI");
    return JSON.parse(content) as AiRgeParams;
  } catch (e) {
    console.error("Erreur lors de l'appel OpenAI", e);
    return { q: query };
  }
}

export async function searchRge(req: Request, res: Response) {
  try {
    const query = String(req.query.q || "").trim();
    if (!query) return res.status(400).json({ error: "Le paramètre q est requis" });

    const aiParams = await parseQueryWithAI(query);

    const manualParams: Partial<AiRgeParams> = {};
    ["code_postal", "siret", "domaine"].forEach((key) => {
      const val = req.query[key];
      if (val) manualParams[key as keyof AiRgeParams] = String(val);
    });

    const finalParams = { ...aiParams, ...manualParams } as AiRgeParams;

    const startParam = req.query.start ? parseInt(String(req.query.start)) : 0;
    const sizeParam = req.query.size ? parseInt(String(req.query.size)) : 20;

    let url = `${RGE_DATASET_URL}?${buildSearchParams(finalParams, startParam, sizeParam)}`;

    const afterParam = req.query.after ? String(req.query.after) : null;
    if (afterParam) {
      url += `&after=${encodeURIComponent(afterParam)}`;
    }

    const rgeResp = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Omnicity-Server/1.0",
      },
    });

    if (!rgeResp.ok) {
      return res
        .status(rgeResp.status)
        .json({ error: `Erreur RGE API (${rgeResp.status}): ${rgeResp.statusText}` });
    }

    const json = await rgeResp.json();
    res.json(json);
  } catch (e) {
    console.error("Erreur searchRge", e);
    res.status(500).json({ error: "Erreur interne serveur" });
  }
} 