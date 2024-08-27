import { createClient } from '@supabase/supabase-js';
import { Request, Response } from 'express';
import { Tables } from '../types/database.types';

import dotenv from 'dotenv';
dotenv.config();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase environment variables");
}

const supabase = createClient(supabaseUrl, supabaseKey);

export async function getCredential(_request: Request, response: Response) {
  try {
    const { data, error } = await supabase
      .from('accounts')
      .select('user');

    if (error) {
      return response.status(500).json({ error: 'Error fetching the IDs from Supabase' });
    }

    return response.status(200).json({ ids: data.map((account) => account.user) });
  } catch (err) {
    return response.status(500).json({ error: 'Server error' });
  }
}