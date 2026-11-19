import { Request, Response } from "express";
import { Database } from "../../types/database.types";

type Energy = Database['public']['Tables']['energy']['Row'];

// Both handlers sit behind requireProjectAccess and query as the calling user (RLS).

export const saveEnergyResult = async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const body: Energy = req.body;

  try {
    const { data, error } = await res.locals.db
      .from("energy")
      .insert({
        id: body.id,
        izi_response: body.izi_response,
        id_project: projectId,
      });

    if (error) throw error;

    res.status(201).json(data);
  } catch (error) {
    console.error("saveEnergyResult failed", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
};

export const getEnergyResult = async (req: Request, res: Response) => {
  const { projectId } = req.params;

  try {
    const { data, error } = await res.locals.db
      .from("energy")
      .select("*")
      .eq("id_project", projectId);

    if (error) throw error;

    res.status(200).json(data);
  } catch (error) {
    console.error("getEnergyResult failed", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
};
