import { Account, Client, Databases, Storage, Teams, Users } from 'node-appwrite';
import { env } from './env';

export const serverClient = new Client()
  .setEndpoint(env.APPWRITE_ENDPOINT)
  .setProject(env.APPWRITE_PROJECT)
  .setKey(env.APPWRITE_API_KEY);

export const databases = new Databases(serverClient);
export const storage = new Storage(serverClient);
export const awUsers = new Users(serverClient);
export const teams = new Teams(serverClient);

export const DB_ID = env.APPWRITE_DATABASE_ID;

// May all point at one physical bucket (free plan) — security is enforced
// per file: script files get NO read permissions (server-only), call
// sheets get team read, avatars get public read.
export const BUCKETS = {
  SCRIPTS: env.APPWRITE_BUCKET_SCRIPTS,
  CALLSHEETS: env.APPWRITE_BUCKET_CALLSHEETS,
  AVATARS: env.APPWRITE_BUCKET_AVATARS,
} as const;

/** Account service bound to a client-supplied JWT — used to verify the JWT is valid. */
export function accountForJwt(jwt: string): Account {
  const client = new Client()
    .setEndpoint(env.APPWRITE_ENDPOINT)
    .setProject(env.APPWRITE_PROJECT)
    .setJWT(jwt);
  return new Account(client);
}
