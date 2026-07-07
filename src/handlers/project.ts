import { createClient } from '@supabase/supabase-js';
import { Request, Response } from 'express';
import dotenv from 'dotenv';
import multer from 'multer';
import { Database } from '../types/database.types';

dotenv.config();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase environment variables");
}
const supabase = createClient(supabaseUrl, supabaseKey);

type Project = Database['public']['Tables']['projects']['Row'];

export const createProject = async (req: Request, res: Response) => {
  const { id_bouquet, id_design, address, state, name, firstName, lastName, contract_type, features, initial_state } = req.body as any;
  const userId = res.locals.user.id;

  const { data, error } = await supabase
    .from('projects')
    .insert([
      { id_bouquet, id_design, address, state, name, firstName, lastName, contract_type, features, initial_state, created_by: userId }
    ])

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  res.status(201).json({ message: 'Project created successfully' });
};

export const createProjects = async (req: Request, res: Response) => {
  const projects: any[] = req.body;
  const userId = res.locals.user.id;
  const projectsWithUser = projects.map(project => ({ ...project, created_by: userId }));

  const { data, error } = await supabase
    .from('projects')
    .insert(projectsWithUser)
    .select('id');

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json({ message: 'Projects created successfully', data: data });
};

export const getProjects = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.user.id;
    
    const { data: projects, error: errorProjects } = await supabase
      .from("projects")
      .select(`
        *,
        energy_choices(id, strategy, choice)
      `)
      .eq("created_by", userId);
    
    if (errorProjects) {
      return res.status(400).json({ error: errorProjects.message });
    }
    
    if (!projects || projects.length === 0) {
      return res.status(200).json([]);
    }

    const projectIds = projects.map((p) => p.id);

    const { data: dpeData, error: errorDpe } = await supabase
      .from("dpe")
      .select("id_project, *")
      .in("id_project", projectIds);
    
    if (errorDpe) {
      return res.status(400).json({ error: errorDpe.message });
    }

    const dpeByProjectId: Record<number, any> = {};
    (dpeData ?? []).forEach((d) => {
      dpeByProjectId[d.id_project] = d;
    });

    const combined = projects.map((project) => {
      const dpeRow = dpeByProjectId[project.id];
      const choiceRow = project.energy_choices;
      
      return {
        ...project,
        strategy: choiceRow?.strategy,
        energyMixChoice: choiceRow?.choice,
        dpe: dpeRow,
        stateOfPlay: project.description,
        costEstimation: choiceRow?.choice
          ? {
              withAid: choiceRow.choice.resteACharge,
              withoutAid: choiceRow.choice.coutTotal,
            }
          : undefined,
        targetedEnergyRating: choiceRow?.choice
          ? choiceRow.choice.etiquette
          : undefined,
        actualEnergyRating: undefined, // Plus d'energy table
        energy_choices: undefined, // On retire cette propriété de la réponse
      };
    });

    res.status(200).json(combined);
  } catch (error) {
    res.status(500).json({ error: error });
  }
};

export const findProject = async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const userId = res.locals.user;

  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .eq('created_by', userId)
    .single();

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  if (!data) {
    return res.status(404).json({ message: 'Project not found' });
  }

  res.status(200).json(data);
};

export const updateProject = async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const {
    id_bouquet,
    id_design,
    address,
    state,
    name,
    created_by,
    firstName,
    lastName,
    contract_type,
    features,
    id_energy_choices,
    initial_state,
  } = req.body as any;
  const userId = res.locals.user.id;

  const fields = {
    id_bouquet,
    id_design,
    address,
    state,
    name,
    created_by,
    firstName,
    lastName,
    contract_type,
    features,
    id_energy_choices,
    initial_state,
  };

  const updateFields = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined)
  );

  const { data, error } = await supabase
    .from('projects')
    .update(updateFields)
    .eq('id', projectId)

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  res.status(200).json(data);
};

export const deleteProject = async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const userId = res.locals.user.id;

  const { data, error } = await supabase
    .from('projects')
    .delete()
    .eq('id', projectId)
    .eq('created_by', userId);

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  res.status(200).json(data);
};

const upload = multer();
export const uploadImage = [
  upload.single('image'),
  async (req: Request, res: Response) => {
    const { projectId, imageId } = req.params;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { data, error } = await supabase.storage
      .from('project-images')
      .upload(`${projectId}/${imageId}`, file.buffer, {
        contentType: file.mimetype,
      });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(data);
  }
];

export const getProjectImages = async (req: Request, res: Response) => {
  const { projectId } = req.params;

  const { data, error } = await supabase.storage
    .from('project-images')
    .list(`${projectId}`);

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  res.status(200).json(data);
};

export const updateProjectImageFullPath = async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const { imageFullPath } = req.body;
  const userId = res.locals.user.id;

  if (!imageFullPath) {
    return res.status(400).json({ error: "Image URL is required" });
  }

  const { data, error } = await supabase
    .from("projects")
    .update({ imageFullPath })
    .eq("id", projectId)
    .eq("created_by", userId);

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  res.status(200).json({ message: "Project image URL updated successfully", data });
};