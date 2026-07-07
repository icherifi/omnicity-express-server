import { Request, Response } from "express";
import { supabase } from "./index";

export const saveEnergyChoice = async (req: Request, res: Response) => {
    const { sessionId, strategy, bouquet } = req.body;
  
    if (!strategy || !bouquet) {
      return res.status(400).json({ error: "Paramètres manquants" });
    }
  
    try {
      const { data, error } = await supabase
        .from('energy_choices')
        .insert({
          strategy: strategy,
          choice: bouquet,
        })
        .select();
  
      if (error) throw error;
  
      return res.status(201).json({ success: true, id: data?.[0]?.id, data });
    } catch (err) {
      console.error("Erreur saveEnergyChoice:", err);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  };
  
  