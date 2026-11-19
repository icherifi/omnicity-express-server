import { Request, Response, NextFunction } from 'express';
import { authClient, createUserClient } from '../lib/supabase';

/**
 * Validates the Supabase JWT and attaches to res.locals:
 *   user, token, db (client acting as the user, RLS enforced), isAdmin, approved.
 * Does NOT reject accounts that are not yet approved - see requireApproved.
 */
export const verifyToken = async (req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const { data, error } = await authClient.auth.getUser(token);

  if (error || !data?.user || data.user.role !== 'authenticated') {
    // Never log the token itself.
    return res.status(401).json({ error: 'Invalid token' });
  }

  const db = createUserClient(token);
  const { data: account, error: accountError } = await db
    .from('accounts')
    .select('admin, approved')
    .eq('user', data.user.id)
    .maybeSingle();

  if (accountError) {
    console.error('Could not load account', accountError.message);
    return res.status(500).json({ error: 'Could not load account' });
  }

  res.locals.user = data.user;
  res.locals.token = token;
  res.locals.db = db;
  res.locals.isAdmin = account?.admin === true;
  // Admins are always approved; a missing account row means "not approved".
  res.locals.approved = account?.admin === true || account?.approved === true;
  next();
};

/** Blocks accounts that an administrator has not activated yet. */
export const requireApproved = (_req: Request, res: Response, next: NextFunction) => {
  if (!res.locals.approved) {
    return res.status(403).json({
      code: 'account_not_approved',
      error: "Votre compte n'est pas encore activé. Contactez un administrateur.",
    });
  }
  next();
};

/** Restricts a route to admins. */
export const requireAdmin = (_req: Request, res: Response, next: NextFunction) => {
  if (!res.locals.isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};
