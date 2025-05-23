import { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase environment variables");
}

const supabase = createClient(supabaseUrl, supabaseKey);

export const saveDpeFormToDb = async (req: Request, res: Response) => {
  try {
    const { dpeFormData, projectId } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'Données manquantes' });
    }

    const { data, error } = await supabase
      .from('dpe')
      .insert({
        id_project: projectId,
        sessionId: dpeFormData.sessionId,
        iziResponse: dpeFormData.iziResponse,
        dpeData: dpeFormData.dpeData,
      })
      .select();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.status(201).json({ message: 'Données DPE enregistrées avec succès', data });
  } catch (error) {
    console.error('Erreur lors de l\'enregistrement des données DPE:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
