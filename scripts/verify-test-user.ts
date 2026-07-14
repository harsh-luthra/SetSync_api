/** Dev utility — marks the test account's email + phone as verified. */
import 'dotenv/config';
import { Client, Query, Users } from 'node-appwrite';

const EMAIL = 'director@setsync.test';

const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT!)
  .setProject(process.env.APPWRITE_PROJECT!)
  .setKey(process.env.APPWRITE_API_KEY!);
const users = new Users(client);

(async () => {
  const list = await users.list([Query.equal('email', EMAIL)]);
  const user = list.users[0];
  if (!user) throw new Error(`${EMAIL} not found — run create-test-user.ts first`);
  await users.updateEmailVerification(user.$id, true);
  await users.updatePhoneVerification(user.$id, true);
  const updated = await users.get(user.$id);
  console.log(`✔ ${EMAIL}: emailVerification=${updated.emailVerification}, phoneVerification=${updated.phoneVerification}`);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
