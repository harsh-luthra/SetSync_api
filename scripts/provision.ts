/**
 * SetSync — one-command Appwrite provisioning (idempotent).
 *
 * Creates: database, all collections + attributes + indexes, storage
 * buckets. Optionally seeds a project + team + director invite when the
 * SEED_* env vars are set.
 *
 * Run: npm run provision
 */
import 'dotenv/config';
import {
  AppwriteException,
  Client,
  Databases,
  ID,
  IndexType,
  Permission,
  Role,
  Storage,
  Teams,
} from 'node-appwrite';

const {
  APPWRITE_ENDPOINT,
  APPWRITE_PROJECT,
  APPWRITE_API_KEY,
  APPWRITE_DATABASE_ID = 'setsync_db',
  SEED_PROJECT_TITLE,
  SEED_PRODUCTION_HOUSE,
  SEED_DIRECTOR_NAME,
  SEED_DIRECTOR_PHONE,
} = process.env;

if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT || !APPWRITE_API_KEY) {
  console.error('Set APPWRITE_ENDPOINT, APPWRITE_PROJECT and APPWRITE_API_KEY in .env first.');
  process.exit(1);
}

const client = new Client()
  .setEndpoint(APPWRITE_ENDPOINT)
  .setProject(APPWRITE_PROJECT)
  .setKey(APPWRITE_API_KEY);
const databases = new Databases(client);
const storage = new Storage(client);
const teams = new Teams(client);

const DB = APPWRITE_DATABASE_ID;

/** Runs fn, treating 409 (already exists) as success. */
async function ensure(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    console.log(`  ✔ ${label}`);
  } catch (err) {
    if (err instanceof AppwriteException && err.code === 409) {
      console.log(`  • ${label} (already exists)`);
    } else {
      throw err;
    }
  }
}

/**
 * Get-first ensure: checks existence before creating. Needed because
 * Appwrite evaluates plan limits BEFORE duplicate IDs — re-creating an
 * existing resource on a maxed-out plan returns 403, not 409.
 */
async function ensureResource(
  label: string,
  get: () => Promise<unknown>,
  create: () => Promise<unknown>,
): Promise<void> {
  try {
    await get();
    console.log(`  • ${label} (already exists)`);
    return;
  } catch (err) {
    if (!(err instanceof AppwriteException) || err.code !== 404) throw err;
  }
  await ensure(label, create);
}

type Attr =
  | { kind: 'string'; key: string; size: number; required?: boolean; array?: boolean }
  | { kind: 'enum'; key: string; elements: string[]; required?: boolean; array?: boolean }
  | { kind: 'int'; key: string; required?: boolean; min?: number; max?: number }
  | { kind: 'bool'; key: string; required?: boolean; default?: boolean }
  | { kind: 'datetime'; key: string; required?: boolean };

interface Index {
  key: string;
  type: IndexType;
  attributes: string[];
}

interface CollectionSpec {
  id: string;
  name: string;
  attrs: Attr[];
  indexes: Index[];
}

const ROLES = ['director', 'associate_director', 'assistant_director', 'actor', 'costume', 'art'];

const COLLECTIONS: CollectionSpec[] = [
  {
    id: 'users',
    name: 'Users',
    attrs: [
      { kind: 'string', key: 'authUserId', size: 64 },
      { kind: 'string', key: 'name', size: 128, required: true },
      { kind: 'string', key: 'phone', size: 32, required: true },
      { kind: 'string', key: 'email', size: 256 },
      { kind: 'enum', key: 'role', elements: ROLES, required: true },
      { kind: 'string', key: 'projectId', size: 36, required: true },
      { kind: 'string', key: 'avatarFileId', size: 36 },
      { kind: 'string', key: 'fcmToken', size: 2048 },
      { kind: 'bool', key: 'active', required: true },
    ],
    indexes: [
      { key: 'idx_authUserId', type: IndexType.Key, attributes: ['authUserId'] },
      { key: 'idx_projectId', type: IndexType.Key, attributes: ['projectId'] },
      { key: 'idx_phone', type: IndexType.Key, attributes: ['phone'] },
    ],
  },
  {
    id: 'projects',
    name: 'Projects',
    attrs: [
      { kind: 'string', key: 'title', size: 256, required: true },
      { kind: 'string', key: 'productionHouse', size: 256 },
      { kind: 'datetime', key: 'startDate' },
      { kind: 'datetime', key: 'endDate' },
      { kind: 'enum', key: 'status', elements: ['prep', 'shooting', 'wrapped'], required: true },
      { kind: 'string', key: 'createdBy', size: 64, required: true },
      { kind: 'string', key: 'scriptFileId', size: 36 },
      { kind: 'int', key: 'scriptVersion', min: 0 },
      { kind: 'int', key: 'scriptPageCount', min: 0 },
    ],
    indexes: [{ key: 'idx_status', type: IndexType.Key, attributes: ['status'] }],
  },
  {
    id: 'shoot_days',
    name: 'Shoot Days',
    attrs: [
      { kind: 'string', key: 'projectId', size: 36, required: true },
      { kind: 'datetime', key: 'date', required: true },
      { kind: 'int', key: 'dayNumber', required: true, min: 1 },
      { kind: 'string', key: 'generalCallTime', size: 8, required: true },
      { kind: 'string', key: 'locationName', size: 256, required: true },
      { kind: 'string', key: 'locationMapUrl', size: 1024 },
      { kind: 'enum', key: 'status', elements: ['draft', 'published', 'completed'], required: true },
      { kind: 'string', key: 'generalNotes', size: 2000 },
      { kind: 'string', key: 'callSheetFileId', size: 36 },
    ],
    indexes: [
      { key: 'idx_projectId', type: IndexType.Key, attributes: ['projectId'] },
      { key: 'idx_date', type: IndexType.Key, attributes: ['date'] },
      { key: 'idx_project_date', type: IndexType.Key, attributes: ['projectId', 'date'] },
    ],
  },
  {
    id: 'scenes',
    name: 'Scenes',
    attrs: [
      { kind: 'string', key: 'projectId', size: 36, required: true },
      { kind: 'string', key: 'shootDayId', size: 36, required: true },
      { kind: 'string', key: 'sceneNumber', size: 16, required: true },
      { kind: 'enum', key: 'intExt', elements: ['INT', 'EXT'], required: true },
      { kind: 'enum', key: 'dayNight', elements: ['DAY', 'NIGHT'], required: true },
      { kind: 'string', key: 'locationName', size: 256, required: true },
      { kind: 'string', key: 'synopsis', size: 2000 },
      { kind: 'string', key: 'actorIds', size: 36, array: true },
      { kind: 'int', key: 'scriptPageStart', required: true, min: 1 },
      { kind: 'int', key: 'scriptPageEnd', required: true, min: 1 },
      {
        kind: 'enum',
        key: 'status',
        elements: ['pending', 'ready', 'shooting', 'completed'],
        required: true,
      },
      { kind: 'int', key: 'order', required: true, min: 0 },
    ],
    indexes: [
      { key: 'idx_projectId', type: IndexType.Key, attributes: ['projectId'] },
      { key: 'idx_shootDayId', type: IndexType.Key, attributes: ['shootDayId'] },
    ],
  },
  {
    id: 'actor_calls',
    name: 'Actor Calls',
    attrs: [
      { kind: 'string', key: 'projectId', size: 36, required: true },
      { kind: 'string', key: 'shootDayId', size: 36, required: true },
      { kind: 'string', key: 'actorId', size: 36, required: true },
      { kind: 'string', key: 'pickupTime', size: 8 },
      { kind: 'string', key: 'callTime', size: 8 },
      { kind: 'string', key: 'makeupTime', size: 8 },
      { kind: 'string', key: 'hairTime', size: 8 },
      { kind: 'string', key: 'onSetTime', size: 8 },
      { kind: 'string', key: 'lunchTime', size: 8 },
      { kind: 'string', key: 'sceneIds', size: 36, array: true },
    ],
    indexes: [
      { key: 'idx_shootDayId', type: IndexType.Key, attributes: ['shootDayId'] },
      { key: 'idx_actorId', type: IndexType.Key, attributes: ['actorId'] },
    ],
  },
  {
    id: 'costumes',
    name: 'Costumes',
    attrs: [
      { kind: 'string', key: 'projectId', size: 36, required: true },
      { kind: 'string', key: 'actorId', size: 36, required: true },
      { kind: 'string', key: 'sceneIds', size: 36, array: true },
      { kind: 'string', key: 'costumeNumber', size: 32, required: true },
      { kind: 'string', key: 'lookDescription', size: 2000 },
      { kind: 'string', key: 'accessories', size: 128, array: true },
      {
        kind: 'enum',
        key: 'status',
        elements: ['pending', 'ready', 'on_actor', 'laundry', 'repair'],
        required: true,
      },
      { kind: 'bool', key: 'tomorrowReady', required: true },
    ],
    indexes: [
      { key: 'idx_projectId', type: IndexType.Key, attributes: ['projectId'] },
      { key: 'idx_actorId', type: IndexType.Key, attributes: ['actorId'] },
    ],
  },
  {
    id: 'props',
    name: 'Props',
    attrs: [
      { kind: 'string', key: 'projectId', size: 36, required: true },
      { kind: 'string', key: 'sceneIds', size: 36, array: true },
      { kind: 'string', key: 'name', size: 256, required: true },
      { kind: 'int', key: 'quantity', required: true, min: 1 },
      { kind: 'string', key: 'notes', size: 2000 },
      {
        kind: 'enum',
        key: 'status',
        elements: ['to_purchase', 'purchased', 'packed', 'on_set', 'returned'],
        required: true,
      },
      { kind: 'datetime', key: 'neededDate' },
    ],
    indexes: [
      { key: 'idx_projectId', type: IndexType.Key, attributes: ['projectId'] },
      { key: 'idx_neededDate', type: IndexType.Key, attributes: ['neededDate'] },
    ],
  },
  {
    id: 'walkie_events',
    name: 'Walkie Events',
    attrs: [
      { kind: 'string', key: 'projectId', size: 36, required: true },
      { kind: 'string', key: 'shootDayId', size: 36, required: true },
      {
        kind: 'enum',
        key: 'type',
        elements: ['scene_ready', 'artist_ready', 'camera_ready', 'lunch_break', 'pack_up', 'custom'],
        required: true,
      },
      { kind: 'string', key: 'message', size: 1000 },
      { kind: 'string', key: 'senderId', size: 36, required: true },
      { kind: 'enum', key: 'senderRole', elements: ROLES, required: true },
      { kind: 'string', key: 'senderName', size: 128, required: true },
    ],
    indexes: [
      { key: 'idx_projectId', type: IndexType.Key, attributes: ['projectId'] },
      { key: 'idx_shootDayId', type: IndexType.Key, attributes: ['shootDayId'] },
    ],
  },
  {
    id: 'attendance',
    name: 'Attendance',
    attrs: [
      { kind: 'string', key: 'projectId', size: 36, required: true },
      { kind: 'string', key: 'shootDayId', size: 36, required: true },
      { kind: 'string', key: 'userId', size: 36, required: true },
      { kind: 'datetime', key: 'checkInTime', required: true },
      { kind: 'enum', key: 'method', elements: ['qr', 'manual'], required: true },
    ],
    indexes: [
      { key: 'idx_shootDayId', type: IndexType.Key, attributes: ['shootDayId'] },
      { key: 'idx_userId', type: IndexType.Key, attributes: ['userId'] },
      { key: 'uniq_day_user', type: IndexType.Unique, attributes: ['shootDayId', 'userId'] },
    ],
  },
  {
    id: 'print_requests',
    name: 'Print Requests',
    attrs: [
      { kind: 'string', key: 'projectId', size: 36, required: true },
      { kind: 'string', key: 'shootDayId', size: 36, required: true },
      { kind: 'string', key: 'actorId', size: 36, required: true },
      { kind: 'string', key: 'actorName', size: 128, required: true },
      { kind: 'enum', key: 'status', elements: ['requested', 'done'], required: true },
    ],
    indexes: [
      { key: 'idx_actorId', type: IndexType.Key, attributes: ['actorId'] },
      { key: 'idx_shootDayId', type: IndexType.Key, attributes: ['shootDayId'] },
    ],
  },
  {
    id: 'notifications',
    name: 'Notifications',
    attrs: [
      { kind: 'string', key: 'projectId', size: 36, required: true },
      { kind: 'string', key: 'targetRoles', size: 32, array: true },
      { kind: 'string', key: 'targetUserIds', size: 36, array: true },
      { kind: 'string', key: 'title', size: 256, required: true },
      { kind: 'string', key: 'body', size: 1024, required: true },
      { kind: 'string', key: 'type', size: 64, required: true },
      { kind: 'string', key: 'deepLink', size: 512, required: true },
      { kind: 'string', key: 'readBy', size: 36, array: true },
    ],
    indexes: [{ key: 'idx_projectId', type: IndexType.Key, attributes: ['projectId'] }],
  },
  {
    id: 'dpr',
    name: 'DPR Snapshots',
    attrs: [
      { kind: 'string', key: 'projectId', size: 36, required: true },
      { kind: 'string', key: 'shootDayId', size: 36, required: true },
      { kind: 'datetime', key: 'date', required: true },
      { kind: 'int', key: 'scenesPlanned', required: true, min: 0 },
      { kind: 'int', key: 'scenesCompleted', required: true, min: 0 },
    ],
    indexes: [{ key: 'idx_projectId', type: IndexType.Key, attributes: ['projectId'] }],
  },
];

async function createAttribute(collectionId: string, attr: Attr): Promise<void> {
  const label = `${collectionId}.${attr.key}`;
  await ensure(label, () => {
    switch (attr.kind) {
      case 'string':
        return databases.createStringAttribute(
          DB,
          collectionId,
          attr.key,
          attr.size,
          attr.required ?? false,
          undefined,
          attr.array ?? false,
        );
      case 'enum':
        return databases.createEnumAttribute(
          DB,
          collectionId,
          attr.key,
          attr.elements,
          attr.required ?? false,
          undefined,
          attr.array ?? false,
        );
      case 'int':
        return databases.createIntegerAttribute(
          DB,
          collectionId,
          attr.key,
          attr.required ?? false,
          attr.min,
          attr.max,
        );
      case 'bool':
        return databases.createBooleanAttribute(
          DB,
          collectionId,
          attr.key,
          attr.required ?? false,
          attr.required ? undefined : attr.default,
        );
      case 'datetime':
        return databases.createDatetimeAttribute(DB, collectionId, attr.key, attr.required ?? false);
    }
  });
}

/** Poll until every attribute of the collection is 'available' (indexes need this). */
async function waitForAttributes(collectionId: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const res = await databases.listAttributes(DB, collectionId);
    const attrs = res.attributes as unknown as { key: string; status: string }[];
    const pending = attrs.filter((a) => a.status !== 'available');
    if (pending.length === 0) return;
    const failed = pending.filter((a) => a.status === 'failed' || a.status === 'stuck');
    if (failed.length > 0) {
      throw new Error(
        `Attributes failed in ${collectionId}: ${failed.map((a) => a.key).join(', ')} — delete them in the Appwrite console and re-run.`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for attributes of ${collectionId}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function seed(): Promise<void> {
  if (!SEED_PROJECT_TITLE || !SEED_DIRECTOR_NAME || !SEED_DIRECTOR_PHONE) {
    console.log('\nNo SEED_* env vars — skipping project seeding.');
    console.log('Set SEED_PROJECT_TITLE, SEED_DIRECTOR_NAME, SEED_DIRECTOR_PHONE to seed a project.');
    return;
  }

  console.log('\nSeeding project…');
  const existing = await databases.listDocuments(DB, 'projects', []);
  const dup = (existing.documents as unknown as { $id: string; title: string }[]).find(
    (p) => p.title === SEED_PROJECT_TITLE,
  );
  if (dup) {
    console.log(`  • project "${SEED_PROJECT_TITLE}" already exists (${dup.$id})`);
    return;
  }

  const projectId = ID.unique();
  const teamId = `team_${projectId}`;
  await teams.create(teamId, `${SEED_PROJECT_TITLE} crew`, ROLES);
  console.log(`  ✔ team ${teamId}`);

  await databases.createDocument(
    DB,
    'projects',
    projectId,
    {
      title: SEED_PROJECT_TITLE,
      productionHouse: SEED_PRODUCTION_HOUSE || '',
      status: 'prep',
      createdBy: 'provision-script',
      scriptVersion: 0,
    },
    [Permission.read(Role.team(teamId))],
  );
  console.log(`  ✔ project document ${projectId}`);

  const phone = SEED_DIRECTOR_PHONE.replace(/[^\d+]/g, '');
  await databases.createDocument(
    DB,
    'users',
    ID.unique(),
    {
      name: SEED_DIRECTOR_NAME,
      phone,
      role: 'director',
      projectId,
      active: true,
    },
    [Permission.read(Role.team(teamId))],
  );
  console.log(`  ✔ director invite for ${phone} — first login via /auth/bootstrap will auto-link`);
}

async function main(): Promise<void> {
  console.log(`Provisioning Appwrite project "${APPWRITE_PROJECT}" @ ${APPWRITE_ENDPOINT}\n`);

  console.log('Database:');
  await ensureResource(
    `database ${DB}`,
    () => databases.get(DB),
    () => databases.create(DB, 'SetSync'),
  );

  for (const spec of COLLECTIONS) {
    console.log(`\nCollection ${spec.id}:`);
    // documentSecurity=true, no collection-level client permissions:
    // per-document team read perms are set by the server; ALL writes go
    // through the Node API key (spec §3 permissions model).
    await ensureResource(
      `collection ${spec.id}`,
      () => databases.getCollection(DB, spec.id),
      () => databases.createCollection(DB, spec.id, spec.name, [], true),
    );
    for (const attr of spec.attrs) {
      await createAttribute(spec.id, attr);
    }
    await waitForAttributes(spec.id);
    for (const index of spec.indexes) {
      await ensure(`${spec.id}#${index.key}`, () =>
        databases.createIndex(DB, spec.id, index.key, index.type, index.attributes),
      );
    }
  }

  console.log('\nStorage buckets:');
  // The three logical buckets (scripts / callsheets / avatars) may share
  // one physical bucket on the free plan (1-bucket limit). Isolation is
  // per-file: scripts get NO read permissions (server-only), call sheets
  // get team read, avatars get public read. fileSecurity=true + no
  // bucket-level permissions makes per-file permissions authoritative.
  const bucketPurposes: Record<string, { extensions: string[] }> = {};
  const logical: { id: string | undefined; fallback: string; extensions: string[] }[] = [
    { id: process.env.APPWRITE_BUCKET_SCRIPTS, fallback: 'scripts', extensions: ['pdf'] },
    { id: process.env.APPWRITE_BUCKET_CALLSHEETS, fallback: 'scripts', extensions: ['pdf'] },
    {
      id: process.env.APPWRITE_BUCKET_AVATARS,
      fallback: 'scripts',
      extensions: ['jpg', 'jpeg', 'png', 'webp'],
    },
  ];
  for (const { id, fallback, extensions } of logical) {
    const bucketId = id || fallback;
    bucketPurposes[bucketId] = {
      extensions: [...new Set([...(bucketPurposes[bucketId]?.extensions ?? []), ...extensions])],
    };
  }
  for (const [bucketId, { extensions }] of Object.entries(bucketPurposes)) {
    // 50 MB — the maximum allowed on the Appwrite Cloud free plan
    let exists = true;
    try {
      await storage.getBucket(bucketId);
    } catch (err) {
      if (!(err instanceof AppwriteException) || err.code !== 404) throw err;
      exists = false;
    }
    if (exists) {
      await storage.updateBucket(bucketId, 'SetSync Files', [], true, true, 50_000_000, extensions);
      console.log(`  • bucket ${bucketId} (already exists — settings reconciled)`);
    } else {
      await ensure(`bucket ${bucketId}`, () =>
        storage.createBucket(bucketId, 'SetSync Files', [], true, true, 50_000_000, extensions),
      );
    }
  }

  await seed();

  console.log('\n✅ Provisioning complete.');
  console.log('Remember (manual, in Appwrite console): enable Phone (OTP) + Email/Password auth.');
}

main().catch((err) => {
  console.error('\n❌ Provisioning failed:', err);
  process.exit(1);
});
