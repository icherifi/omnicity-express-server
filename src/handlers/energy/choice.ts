import { Request, Response } from "express";

export const saveEnergyChoice = async (req: Request, res: Response) => {
  const { projectId, strategy, bouquet } = req.body;

  if (!strategy || !bouquet) {
    return res.status(400).json({ error: "Paramètres manquants" });
  }
  if (typeof projectId !== "string" || !projectId) {
    return res.status(400).json({ error: "projectId manquant" });
  }

  try {
    // Runs as the calling user: row level security rejects a project they can't access.
    const { data, error } = await res.locals.db
      .from("energy_choices")
      .insert({
        id_project: projectId,
        strategy: strategy,
        choice: bouquet,
      })
      .select();

    if (error) {
      const forbidden = error.code === "42501";
      return res.status(forbidden ? 403 : 500).json({ error: forbidden ? "Forbidden" : "Erreur serveur" });
    }

    return res.status(201).json({ success: true, id: data?.[0]?.id, data });
  } catch (err) {
    console.error("Erreur saveEnergyChoice:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
};
