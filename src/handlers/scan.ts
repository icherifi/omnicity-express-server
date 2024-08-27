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


export const createScan = async (req: Request, res: Response) => {
  const { author, created_at, description, id, serialized }: CreateScanDto = req.body;

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
    return res.status(500).json({ message: 'Error adding scan', details: error.message });
  }

  res.send("Scan created successfully!");
};

export const getScans = async (req: Request, res: Response) => {
    try {
      // Fetch data from the scans table
      const { data, error } = await supabase
        .from('scans')
        .select('*');
  
      if (error) {
        throw error;
      }
  
      // Send success response
      res.status(200).json({ message: 'Scans retrieved successfully', data });
    } catch (error) {
      // Send error response
      res.status(500).json({ message: 'Error retrieving scans' });
    }
  };