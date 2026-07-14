import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.string().default('development'),
  PUBLIC_BASE_URL: z.string().optional(),
  CORS_ORIGINS: z.string().default('*'),

  APPWRITE_ENDPOINT: z.string().url(),
  APPWRITE_PROJECT: z.string().min(1),
  APPWRITE_API_KEY: z.string().min(1),
  APPWRITE_DATABASE_ID: z.string().default('setsync_db'),

  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),

  QR_HMAC_SECRET: z.string().min(16),
  URL_SIGN_SECRET: z.string().optional(),

  SEED_PROJECT_TITLE: z.string().optional(),
  SEED_PRODUCTION_HOUSE: z.string().optional(),
  SEED_DIRECTOR_NAME: z.string().optional(),
  SEED_DIRECTOR_PHONE: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`   ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export const urlSignSecret = env.URL_SIGN_SECRET || env.QR_HMAC_SECRET;
export const APP_TIMEZONE = 'Asia/Kolkata';
