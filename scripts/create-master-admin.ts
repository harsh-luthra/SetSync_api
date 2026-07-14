/**
 * Dev utility — creates the master admin sign-in account (idempotent).
 * The email must also be listed in MASTER_ADMIN_EMAILS in .env.
 *
 * Run: npx tsx scripts/create-master-admin.ts [email] [password] [name]
 */
import 'dotenv/config';
import { AppwriteException, Client, ID, Query, Users } from 'node-appwrite';

const EMAIL = (process.argv[2] || 'master@setsync.test').toLowerCase();
const PASSWORD = process.argv[3] || 'Master#2026';
const NAME = process.argv[4] || 'Master Admin';

const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT!)
  .setProject(process.env.APPWRITE_PROJECT!)
  .setKey(process.env.APPWRITE_API_KEY!);
const users = new Users(client);

(async () => {
  let userId: string;
  try {
    const created = await users.create(ID.unique(), EMAIL, undefined, PASSWORD, NAME);
    userId = created.$id;
    console.log(`✔ created master account ${EMAIL} (${userId})`);
  } catch (err) {
    if (err instanceof AppwriteException && err.code === 409) {
      const list = await users.list([Query.equal('email', EMAIL)]);
      userId = list.users[0].$id;
      console.log(`• master account ${EMAIL} exists (${userId})`);
    } else throw err;
  }
  await users.updateEmailVerification(userId, true);
  await users.updateLabels(userId, ['master']);

  const inEnv = (process.env.MASTER_ADMIN_EMAILS || '')
    .toLowerCase()
    .split(',')
    .map((e) => e.trim())
    .includes(EMAIL);

  console.log('\nMaster sign-in:');
  console.log(`  Email:    ${EMAIL}`);
  console.log(`  Password: ${PASSWORD}`);
  if (!inEnv) {
    console.log(`\n⚠ Add to .env and restart the server:  MASTER_ADMIN_EMAILS=${EMAIL}`);
  } else {
    console.log('  MASTER_ADMIN_EMAILS: ✔ listed');
  }
})().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
