import { Request, Response } from 'express';
import { z } from 'zod';

// Scans belong to a project: access is decided by row level security through
// can_access_project(project_id). See supabase/migrations/20261118000000_multi_user_access.sql.

const createScanPayload = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  project_id: z.string().uuid(),
  description: z.string().nullish(),
  serialized: z.unknown().optional(),
  usdz_path: z.string().nullish(),
  created_at: z.string().optional(),
});

export const createScan = async (req: Request, res: Response) => {
  const parsed = createScanPayload.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid scan payload' });
  }
  const { id, project_id, description, serialized, usdz_path, created_at } = parsed.data;

  // The author is the authenticated user, never a client-supplied value.
  const author = res.locals.user.email ?? res.locals.user.id;

  const { error } = await res.locals.db
    .from('scans')
    .insert({ id, author, created_at, description, project_id, serialized, usdz_path });

  if (error) {
    // RLS refusal (project not accessible) surfaces as a policy violation.
    const forbidden = error.code === '42501';
    return res.status(forbidden ? 403 : 500).json({ error: forbidden ? 'Forbidden' : 'Could not create scan' });
  }

  res.status(201).json({ message: 'Scan created successfully!' });
};

export const getScansByProjectId = async (req: Request, res: Response) => {
  const { projectId } = req.params;

  const { data, error } = await res.locals.db
    .from('scans')
    .select('*')
    .eq('project_id', projectId);

  if (error) {
    return res.status(500).json({ error: 'Could not load scans' });
  }

  res.status(200).json(data);
};
