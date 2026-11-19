import { Request, Response } from 'express';

export const saveDpeFormToDb = async (req: Request, res: Response) => {
  try {
    const { dpeFormData, projectId } = req.body;

    if (typeof projectId !== 'string' || !projectId || !dpeFormData) {
      return res.status(400).json({ error: 'Données manquantes' });
    }

    // Runs as the calling user: row level security rejects a project they can't access.
    const { data, error } = await res.locals.db
      .from('dpe')
      .insert({
        id_project: projectId,
        sessionId: dpeFormData.sessionId,
        iziResponse: dpeFormData.iziResponse,
        dpeData: dpeFormData.dpeData,
      })
      .select();

    if (error) {
      const forbidden = error.code === '42501';
      return res.status(forbidden ? 403 : 500).json({ error: forbidden ? 'Forbidden' : 'Erreur serveur' });
    }

    res.status(201).json({ message: 'Données DPE enregistrées avec succès', data });
  } catch (error) {
    console.error("Erreur lors de l'enregistrement des données DPE:", error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
