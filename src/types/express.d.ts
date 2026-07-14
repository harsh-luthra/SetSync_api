import type { RequestUser } from './index';

declare global {
  namespace Express {
    interface Request {
      /** Raw Appwrite auth account (set by verifyJwt) */
      authUser?: { $id: string; name: string; phone: string; email: string };
      /** Loaded SetSync profile (set by loadProfile) */
      user?: RequestUser;
    }
  }
}

export {};
