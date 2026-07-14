/**
 * Dev utility — sends a test notification to ALL crew of the first project
 * through the real notification service (in-app document + FCM push).
 *
 * Run: npx tsx scripts/send-test-notification.ts ["Optional custom message"]
 */
import 'dotenv/config';
import { Query } from 'node-appwrite';
import { COL, listAllDocs, listDocs } from '../src/services/appwrite.service';
import { notify } from '../src/services/notification.service';
import type { Project, UserProfile } from '../src/types';

(async () => {
  const projects = await listDocs<Project>(COL.PROJECTS, [Query.limit(1)]);
  const project = projects.documents[0];
  if (!project) throw new Error('No project found — seed one first');

  const crew = await listAllDocs<UserProfile>(COL.USERS, [
    Query.equal('projectId', project.$id),
    Query.equal('active', true),
  ]);
  const withToken = crew.filter((u) => !!u.fcmToken);

  console.log(`Project: "${project.title}" (${project.$id})`);
  console.log(`Crew: ${crew.length} active member(s)`);
  for (const u of crew) {
    console.log(`  - ${u.name} (${u.role}) — fcmToken: ${u.fcmToken ? 'YES (' + u.fcmToken.slice(0, 20) + '…)' : 'none'}`);
  }

  const body = process.argv[2] || `Test push from SetSync backend — ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
  const doc = await notify({
    projectId: project.$id,
    title: '🔔 SetSync test notification',
    body,
    type: 'test',
    deepLink: 'setsync://home',
    sound: true,
  });

  console.log(`\n✔ Notification document created: ${doc.$id} (in-app bell via Appwrite realtime)`);
  if (withToken.length === 0) {
    console.log('⚠ No crew member has an FCM token yet — no push was sent.');
    console.log('  A device gets a token when the app calls POST /api/v1/users/fcm-token after login.');
  } else {
    console.log(`✔ FCM push attempted to ${withToken.length} device token(s) — check the device(s) and the log lines above for failures.`);
  }
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
