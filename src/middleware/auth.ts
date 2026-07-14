import type { NextFunction, Request, Response } from 'express';
import jwtLib from 'jsonwebtoken';
import { Query } from 'node-appwrite';
import { accountForJwt, databases, DB_ID } from '../config/appwrite';
import { COL } from '../services/appwrite.service';
import type { UserProfile } from '../types';
import { AppError, asyncHandler } from './errorHandler';

/**
 * Step 1 — verify the Appwrite JWT sent as `Authorization: Bearer <jwt>`.
 * Verification is done by calling Appwrite Account.get() with the JWT-bound
 * client (Appwrite rejects tampered/expired tokens). A cheap local decode
 * short-circuits obviously expired tokens first.
 */
export const verifyJwt = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new AppError(401, 'Missing Authorization: Bearer <appwrite-jwt> header');
  }
  const jwt = header.slice('Bearer '.length).trim();

  const decoded = jwtLib.decode(jwt) as { exp?: number } | null;
  if (decoded?.exp && decoded.exp * 1000 < Date.now()) {
    throw new AppError(401, 'JWT expired');
  }

  try {
    const account = await accountForJwt(jwt).get();
    req.authUser = {
      $id: account.$id,
      name: account.name,
      phone: account.phone,
      email: account.email,
    };
  } catch {
    throw new AppError(401, 'Invalid or expired JWT');
  }
  next();
});

/**
 * Step 2 — load the SetSync `users` profile document and attach
 * {userId, role, projectId} to the request. projectId is ALWAYS derived
 * from the profile, never from client input.
 */
export const loadProfile = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  if (!req.authUser) throw new AppError(401, 'Not authenticated');

  const result = await databases.listDocuments(DB_ID, COL.USERS, [
    Query.equal('authUserId', req.authUser.$id),
    Query.limit(1),
  ]);
  const profile = result.documents[0] as unknown as UserProfile | undefined;

  if (!profile) {
    throw new AppError(403, 'No SetSync profile for this account. Call POST /api/v1/auth/bootstrap first.');
  }
  if (!profile.active) {
    throw new AppError(403, 'Your profile has been deactivated');
  }

  req.user = {
    userId: profile.$id,
    authUserId: req.authUser.$id,
    role: profile.role,
    projectId: profile.projectId,
    name: profile.name,
    phone: profile.phone,
  };
  next();
});

/** Standard auth chain: verify JWT then load profile. */
export const authenticate = [verifyJwt, loadProfile];
