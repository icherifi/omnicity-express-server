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
  const { id_bouquet, id_design, address, state, name } : Project = req.body;
  const userId = res.locals.user.id;

  const { data, error } = await supabase
    .from('projects')
    .insert([
      { id_bouquet, id_design, address, state, name, created_by: userId }
    ])

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  res.status(201).json({ message: 'Project created successfully' });
};

export const createProjects = async (req: Request, res: Response) => {
  const projects: Project[] = req.body;
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
  const userId = res.locals.user.id;

  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('created_by', userId);

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  res.status(200).json(data);
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
  const { id } = req.params;
  const { id_bouquet, id_design, address, state, name, created_by } : Project = req.body;
  const userId = res.locals.user.id;

  const { data, error } = await supabase
    .from('projects')
    .update({ id_bouquet, id_design, address, state, name, created_by })
    .eq('id', id)
    .eq('created_by', userId);

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
