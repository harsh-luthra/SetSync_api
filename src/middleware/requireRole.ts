import type { NextFunction, Request, Response } from 'express';
import type { Role } from '../types';
import { AppError } from './errorHandler';

/** Role guard factory — use after `authenticate`. */
export function requireRole(roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new AppError(401, 'Not authenticated'));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new AppError(403, `Requires one of roles: ${roles.join(', ')}`));
      return;
    }
    next();
  };
}
