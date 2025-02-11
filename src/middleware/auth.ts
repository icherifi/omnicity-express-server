import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase environment variables");
}
const supabase = createClient(supabaseUrl, supabaseKey);

export const verifyToken = async (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    console.log('No token provided');
    return res.status(401).json({ error: 'No token provided' });
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data || !data.user || data.user.role !== 'authenticated') {
    console.log('Invalid token', token);
    return res.status(401).json({ error: 'Invalid token' });
  }

  res.locals.user = data.user;
  next();
};