import { Request, Response, NextFunction } from 'express';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Express param callback: `router.param('projectId', requireProjectAccess)`.
 * The lookup runs with the user's own client, so row level security decides: if the
 * user is not the owner, not an admin and the project is not shared with them, the row
 * is invisible and we answer 404 (we never reveal that the project exists).
 */
export const requireProjectAccess = async (
  _req: Request,
  res: Response,
  next: NextFunction,
  projectId: string,
) => {
  if (!UUID_RE.test(projectId)) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const { data, error } = await res.locals.db
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: 'Could not check project access' });
  }
  if (!data) {
    return res.status(404).json({ error: 'Project not found' });
  }
  next();
};

/** Same idea for routes addressed by scan id (`router.param('id', requireScanAccess)`). */
export const requireScanAccess = async (
  _req: Request,
  res: Response,
  next: NextFunction,
  scanId: string,
) => {
  const id = Number(scanId);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid scan id' });
  }
  const { data, error } = await res.locals.db
    .from('scans')
    .select('id')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: 'Could not check scan access' });
  }
  if (!data) {
    return res.status(404).json({ error: 'Scan not found' });
  }
  next();
};
