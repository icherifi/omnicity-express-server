import { createClient } from '@supabase/supabase-js';
import { Request, Response } from 'express';
import dotenv from 'dotenv';
import { Database } from '../types/database.types';

dotenv.config();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase environment variables");
}
const supabase = createClient(supabaseUrl, supabaseKey);
type Scan = Database['public']['Tables']['scans']['Row'];

export const createScan = async (req: Request, res: Response) => {
  const { author, created_at, description, id, serialized }: Scan = req.body;

  const { error } = await supabase
    .from('scans')
    .insert({
      author: author,
      created_at: created_at,
      description: description,
      id: id,
      serialized: serialized
    });

  if (error) {
    return res.status(500).json({ details: error });
  }

  res.send("Scan created successfully!");
};

export const getScans = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('scans')
      .select('*');

    if (error) {
      throw error;
    }

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ details: error });
  }
};

export const getScansByProjectId = async (req: Request, res: Response) => {
  const { projectId } = req.params;

  try {
    const { data, error } = await supabase
      .from('scans')
      .select('*')
      .eq('project_id', projectId);

    if (error) {
      throw error;
    }

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ details: error });
  }
};
