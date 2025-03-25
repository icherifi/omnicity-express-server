import { Request, Response } from "express";
import { supabase } from "./index";

export const saveEnergyChoice = async (req: Request, res: Response) => {
    const { sessionId, strategy, bouquet } = req.body;
  
    if (!sessionId || !strategy || !bouquet) {
      return res.status(400).json({ error: "Paramètres manquants" });
    }
  
    try {
      const { data, error } = await supabase
        .from('energy_choices')
        .insert({
          id_project: sessionId,
          strategy: strategy,
          choice: bouquet,
        });
  
      if (error) throw error;
  
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("Erreur saveEnergyChoice:", err);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  };
  
  