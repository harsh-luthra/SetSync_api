/**
 * Dev utility — prints a short-lived JWT for any Appwrite account (by email).
 * Run: npx tsx scripts/mint-jwt.ts <email>
 */
import 'dotenv/config';
import { Account, Client, Query, Users } from 'node-appwrite';

const EMAIL = (process.argv[2] || '').toLowerCase();
if (!EMAIL) {
  console.error('Usage: npx tsx scripts/mint-jwt.ts <email>');
  process.exit(1);
}

const server = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT!)
  .setProject(process.env.APPWRITE_PROJECT!)
  .setKey(process.env.APPWRITE_API_KEY!);
const users = new Users(server);

(async () => {
  const list = await users.list([Query.equal('email', EMAIL)]);
  const user = list.users[0];
  if (!user) throw new Error(`No account with email ${EMAIL}`);
  const session = await users.createSession(user.$id);
  const sessionClient = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT!)
    .setProject(process.env.APPWRITE_PROJECT!)
    .setSession(session.secret);
  const { jwt } = await new Account(sessionClient).createJWT();
  console.log(jwt);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
