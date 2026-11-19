import { Request, Response } from "express";

/** GET /api/me — who am I, and has an administrator activated my account yet? */
export const getMe = (_req: Request, res: Response) => {
  const user = res.locals.user;
  res.status(200).json({
    id: user.id,
    email: user.email,
    emailConfirmed: Boolean(user.email_confirmed_at),
    approved: res.locals.approved === true,
    admin: res.locals.isAdmin === true,
  });
};
