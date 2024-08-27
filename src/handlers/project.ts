import { createClient } from '@supabase/supabase-js';
import { Request, Response } from 'express';
import { Scan } from '../types/scan.types';
import { CreateScanDto } from '../dtos/CreateScan.dto';

import dotenv from 'dotenv';
dotenv.config();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase environment variables");
}
const supabase = createClient(supabaseUrl, supabaseKey);


export const createProject = async (req: Request, res: Response) => {
//TODO: Implement createProject
};

export const getProjects = async (req: Request, res: Response) => {
//TODO: Implement getProjects
};