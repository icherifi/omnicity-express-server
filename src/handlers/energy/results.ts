import { Request, Response } from "express";
import { supabase } from "./index";
import { Database } from "../../types/database.types";

type Energy = Database['public']['Tables']['energy']['Row'];

export const saveEnergyResult = async (req: Request, res: Response) => {
    const { projectId } = req.params;
    const body : Energy = req.body;
  
    try {
      const { data, error } = await supabase
        .from("energy")
        .insert({
          id: body.id,
          izi_response: body.izi_response,
          id_project: projectId,
        });
  
      if (error) throw error;
  
      res.status(201).json(data);
    } catch (error) {
      res.status(500).json({ error: error });
    }
  };
  
export const getEnergyResult = async (req: Request, res: Response) => {
    const { projectId } = req.params;

    try {
        const { data, error } = await supabase
        .from("energy")
        .select("*")
        .eq("id_project", projectId);

        if (error) throw error;

        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ error: error });
    }
};