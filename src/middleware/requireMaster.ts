import type { NextFunction, Request, Response } from 'express';
import { masterEmails } from '../config/env';
import { AppError } from './errorHandler';

/**
 * Master-admin guard — use after verifyJwt (no SetSync profile needed).
 * Masters are identified by email via MASTER_ADMIN_EMAILS.
 */
export function requireMaster(req: Request, _res: Response, next: NextFunction): void {
  if (!req.authUser) {
    next(new AppError(401, 'Not authenticated'));
    return;
  }
  if (!masterEmails.includes(req.authUser.email.toLowerCase())) {
    next(new AppError(403, 'Master admin access required'));
    return;
  }
  next();
}

export function isMasterEmail(email: string | undefined): boolean {
  return !!email && masterEmails.includes(email.toLowerCase());
}
