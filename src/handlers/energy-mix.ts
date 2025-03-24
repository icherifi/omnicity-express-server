import { Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";

export async function saveEnergyMix(req: Request, res: Response) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing Supabase environment variables");
    }
    
    const supabase = createClient(supabaseUrl, supabaseKey);
    const { sessionId, strategy, bouquet } = req.body;
  
    if (!sessionId || !strategy || !bouquet) {
      return res.status(400).json({ error: "Paramètres manquants" });
    }
  
    try {
      const { data, error } = await supabase
        .from('energy_mixes')
        .insert({
          id_project: sessionId,
          strategy: strategy,
          mix: bouquet,
        });

      if (error) throw error;
  
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("Erreur saveBouquet:", err);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }