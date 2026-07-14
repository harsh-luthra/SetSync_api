/**
 * Dev utility — creates a complete, ready-to-sign-in test setup:
 *   1. A demo project + Appwrite team (if no project exists yet)
 *   2. A director profile in the `users` collection
 *   3. An Appwrite auth account (email + password + phone), pre-linked to
 *      the profile (so /auth/bootstrap just returns it)
 *   4. A short-lived JWT for immediate Postman/Thunder Client testing
 *
 * Run: npx tsx scripts/create-test-user.ts
 * NOT for production use.
 */
import 'dotenv/config';
import {
  Account,
  AppwriteException,
  Client,
  Databases,
  ID,
  Permission,
  Query,
  Role,
  Teams,
  Users,
} from 'node-appwrite';

const EMAIL = 'director@setsync.test';
const PASSWORD = 'SetSync#2026';
const PHONE = '+919000000001';
const NAME = 'Test Director';
const PROJECT_TITLE = 'Demo Production';

const { APPWRITE_ENDPOINT, APPWRITE_PROJECT, APPWRITE_API_KEY, APPWRITE_DATABASE_ID } = process.env;
if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT || !APPWRITE_API_KEY || !APPWRITE_DATABASE_ID) {
  console.error('Fill .env first (APPWRITE_ENDPOINT / APPWRITE_PROJECT / APPWRITE_API_KEY / APPWRITE_DATABASE_ID).');
  process.exit(1);
}

const server = new Client()
  .setEndpoint(APPWRITE_ENDPOINT)
  .setProject(APPWRITE_PROJECT)
  .setKey(APPWRITE_API_KEY);
const databases = new Databases(server);
const teams = new Teams(server);
const users = new Users(server);
const DB = APPWRITE_DATABASE_ID;

async function main(): Promise<void> {
  // --- 1. Project + team ---
  let projectId: string;
  const projects = await databases.listDocuments(DB, 'projects', [Query.limit(1)]);
  if (projects.documents[0]) {
    projectId = projects.documents[0].$id;
    console.log(`• project exists: "${(projects.documents[0] as any).title}" (${projectId})`);
  } else {
    projectId = ID.unique();
    await teams.create(`team_${projectId}`, `${PROJECT_TITLE} crew`, [
      'director', 'associate_director', 'assistant_director', 'actor', 'costume', 'art',
    ]);
    await databases.createDocument(
      DB, 'projects', projectId,
      { title: PROJECT_TITLE, productionHouse: 'SetSync Test', status: 'shooting', createdBy: 'create-test-user', scriptVersion: 0 },
      [Permission.read(Role.team(`team_${projectId}`))],
    );
    console.log(`✔ created project "${PROJECT_TITLE}" (${projectId}) + team`);
  }
  const teamId = `team_${projectId}`;

  // --- 2. Director profile in `users` collection ---
  let profileId: string;
  const profiles = await databases.listDocuments(DB, 'users', [
    Query.equal('projectId', projectId),
    Query.equal('phone', PHONE),
    Query.limit(1),
  ]);
  if (profiles.documents[0]) {
    profileId = profiles.documents[0].$id;
    console.log(`• profile exists (${profileId})`);
  } else {
    profileId = ID.unique();
    await databases.createDocument(
      DB, 'users', profileId,
      { name: NAME, phone: PHONE, role: 'director', projectId, active: true },
      [Permission.read(Role.team(teamId))],
    );
    console.log(`✔ created director profile (${profileId})`);
  }

  // --- 3. Appwrite auth account ---
  let authUserId: string;
  try {
    const created = await users.create(ID.unique(), EMAIL, PHONE, PASSWORD, NAME);
    authUserId = created.$id;
    console.log(`✔ created auth account ${EMAIL} (${authUserId})`);
  } catch (err) {
    if (err instanceof AppwriteException && err.code === 409) {
      const list = await users.list([Query.equal('email', EMAIL)]);
      authUserId = list.users[0].$id;
      console.log(`• auth account ${EMAIL} exists (${authUserId})`);
    } else throw err;
  }

  // --- Link profile ↔ auth account + team membership ---
  await databases.updateDocument(DB, 'users', profileId, { authUserId });
  try {
    await teams.createMembership(teamId, ['director'], undefined, authUserId, undefined, undefined, NAME);
    console.log('✔ added to project team');
  } catch (err) {
    if (err instanceof AppwriteException && err.code === 409) console.log('• already a team member');
    else console.log(`! team membership skipped: ${(err as Error).message}`);
  }

  // --- 4. Mint a JWT for API testing ---
  // Server SDK creates a session (secret included), then a session-bound
  // client mints the JWT — same thing the Flutter SDK does after login.
  let jwt: string | null = null;
  try {
    const session = await users.createSession(authUserId);
    const sessionClient = new Client()
      .setEndpoint(APPWRITE_ENDPOINT!)
      .setProject(APPWRITE_PROJECT!)
      .setSession(session.secret);
    jwt = (await new Account(sessionClient).createJWT()).jwt;
  } catch (err) {
    console.log(`! could not mint JWT automatically: ${(err as Error).message}`);
  }

  console.log('\n────────────────────────────────────────────');
  console.log('TEST SIGN-IN CREDENTIALS (email + password):');
  console.log(`  Email:    ${EMAIL}`);
  console.log(`  Password: ${PASSWORD}`);
  console.log(`  Phone:    ${PHONE}`);
  console.log(`  Role:     director  |  Project: ${projectId}`);
  if (jwt) {
    console.log('\nJWT for Postman (valid ~15 min, then re-run this script):');
    console.log(jwt);
    console.log('\nTry:  curl -H "Authorization: Bearer <jwt>" http://localhost:3000/api/v1/crew');
  }
  console.log('────────────────────────────────────────────');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
