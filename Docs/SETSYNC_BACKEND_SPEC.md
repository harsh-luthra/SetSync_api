# SetSync — Backend Specification
### Node.js API Server + Appwrite (Database, Auth, Storage, Realtime)
**Version:** MVP 1.0
**Target:** Node.js (Express) REST API + Appwrite Cloud (or self-hosted Appwrite)
**Consumed by:** SetSync Flutter app (separate document)

---

## 1. ARCHITECTURE OVERVIEW

**Division of responsibility (important — do not blur this):**

| Concern | Owner |
|---------|-------|
| Auth (phone OTP / email), sessions | Appwrite Auth (Flutter talks to Appwrite directly) |
| Database (all collections) | Appwrite Databases |
| Realtime subscriptions | Appwrite Realtime (Flutter subscribes directly) |
| File storage (scripts, call sheet PDFs, bills) | Appwrite Storage |
| Complex workflows, validation, fan-out notifications, PDF generation, QR tokens, script slicing | **Node.js server** |
| Push notifications | FCM, triggered by Node.js |

Flutter reads mostly directly from Appwrite (fast, realtime). All **writes that trigger side effects** go through the Node.js API, which validates role permissions, writes to Appwrite via the Server SDK (node-appwrite, API key), and fans out notifications.

```
Flutter ──auth/realtime/reads──▶ Appwrite
Flutter ──writes & workflows──▶ Node.js API ──server SDK──▶ Appwrite
                                     └──────▶ FCM push
```

---

## 2. TECH STACK

- Node.js 20+, Express 4, TypeScript
- `node-appwrite` (server SDK, API key with full scopes)
- `firebase-admin` (FCM push)
- `pdfkit` or `puppeteer` (call sheet PDF generation — prefer puppeteer + HTML template for a polished sheet)
- `zod` (request validation)
- `jsonwebtoken` (verify Appwrite JWT from clients)
- `node-cron` (scheduled jobs)
- `pino` (logging)
- Deployment target: any Node host (Railway/Render/VPS). Include Dockerfile.

### Folder structure
```
src/
├── index.ts               # express bootstrap
├── config/                # env, appwrite client, firebase admin init
├── middleware/
│   ├── auth.ts            # verify Appwrite JWT → attach user {id, role, projectId}
│   ├── requireRole.ts     # role guard factory
│   └── errorHandler.ts
├── routes/
│   ├── shootdays.ts
│   ├── scenes.ts
│   ├── actors.ts
│   ├── costumes.ts
│   ├── props.ts
│   ├── walkie.ts
│   ├── attendance.ts
│   ├── script.ts
│   ├── callsheet.ts
│   └── notifications.ts
├── services/
│   ├── appwrite.service.ts    # typed CRUD wrappers per collection
│   ├── notification.service.ts # role/user fan-out + FCM send
│   ├── pdf.service.ts          # call sheet PDF from HTML template
│   ├── script.service.ts       # per-actor scene slicing + watermark metadata
│   └── qr.service.ts           # rotating attendance tokens
├── jobs/
│   └── tomorrowReminder.ts     # 8 PM cron: remind AD if tomorrow unpublished
├── templates/
│   └── callsheet.html          # styled call sheet template
└── types/                      # shared TS types (mirror Flutter models)
```

---

## 3. APPWRITE SETUP

**Project:** `setsync` | **Database:** `setsync_db`

### Auth
- Enable **Phone (OTP)** and Email/Password
- After first login, Node.js `/auth/bootstrap` endpoint creates the `users` profile document (role assigned by admin via `/crew/invite`)

### Teams (permissions model)
- One Appwrite **Team per project** (`team_{projectId}`), with roles: `director`, `associate_director`, `assistant_director`, `actor`, `costume`, `art`
- Collection documents get team-based read permissions; **writes are restricted to the server API key only** (clients cannot write directly — forces all writes through Node.js validation). Exception: none in MVP.

### Storage buckets
- `scripts` — full script PDF (admin upload). **No client read access.** Only Node.js reads it to slice per-actor pages.
- `callsheets` — generated call sheet PDFs. Team read.
- `avatars` — public read.

---

## 4. DATABASE COLLECTIONS (Appwrite)

> All collections have `projectId` (string, indexed). Timestamps via Appwrite `$createdAt/$updatedAt`.

### `users`
| Attribute | Type | Notes |
|---|---|---|
| authUserId | string, indexed | Appwrite auth user id |
| name | string | |
| phone | string | |
| role | enum: director, associate_director, assistant_director, actor, costume, art | |
| projectId | string, indexed | |
| avatarFileId | string? | |
| fcmToken | string? | updated by `/users/fcm-token` |
| active | boolean | |

### `projects`
title, productionHouse, startDate, endDate, status (enum: prep, shooting, wrapped), createdBy

### `shoot_days`
| Attribute | Type |
|---|---|
| projectId | string, indexed |
| date | datetime, indexed |
| dayNumber | integer |
| generalCallTime | string "07:00" |
| locationName | string |
| locationMapUrl | string? |
| status | enum: draft, published, completed |
| generalNotes | string? |
| callSheetFileId | string? (generated PDF) |

### `scenes`
projectId, shootDayId (indexed), sceneNumber (string), intExt (enum INT/EXT), dayNight (enum), locationName, synopsis, actorIds (string[]), scriptPageStart (int), scriptPageEnd (int), status (enum: pending, ready, shooting, completed), order (int)

### `actor_calls`
shootDayId (indexed), actorId (indexed), pickupTime, callTime, makeupTime, hairTime, onSetTime, sceneIds (string[]), lunchTime

### `costumes`
projectId, actorId (indexed), sceneIds (string[]), costumeNumber, lookDescription, accessories (string[]), status (enum: pending, ready, on_actor, laundry, repair), tomorrowReady (bool)

### `props`
projectId (indexed), sceneIds (string[]), name, quantity (int), notes?, status (enum: to_purchase, purchased, packed, on_set, returned), neededDate (datetime?, indexed)

### `walkie_events`
projectId (indexed), shootDayId (indexed), type (enum: scene_ready, artist_ready, camera_ready, lunch_break, pack_up, custom), message?, senderId, senderRole, senderName

### `attendance`
projectId, shootDayId (indexed), userId (indexed), checkInTime, method (enum: qr, manual)
Unique index on (shootDayId, userId).

### `print_requests`
projectId, shootDayId, actorId (indexed), actorName, status (enum: requested, done)

### `notifications`
projectId (indexed), targetRoles (string[]), targetUserIds (string[]), title, body, type (string), deepLink (string), readBy (string[])

---

## 5. REST API (all under `/api/v1`, JWT required unless noted)

**Auth middleware:** client sends Appwrite JWT (`Authorization: Bearer <jwt>`). Server verifies via Appwrite, loads `users` profile, attaches `{userId, role, projectId}`. Every query is force-scoped to `projectId` — never trust projectId from request body.

### Auth & Users
- `POST /auth/bootstrap` — after first login; creates/fetches profile
- `POST /users/fcm-token` — save FCM token
- `POST /crew/invite` — admin only; pre-register {phone, name, role} so login auto-links
- `GET /crew` — admin: list crew with roles + today's attendance flag

### Shoot Days & Scenes (admin roles only for writes)
- `POST /shootdays` | `PATCH /shootdays/:id`
- `POST /shootdays/:id/publish` — **THE key workflow:**
  1. Validate: every scene has actors; every actor in scenes has an actor_call entry (else 422 with a human-readable missing list)
  2. Set status=published
  3. Generate call sheet PDF (pdf.service) → upload to `callsheets` bucket → save fileId
  4. Notify ALL project crew: "📋 Call sheet for Day {n} ({date}) is out — Call time {time}" + deepLink
- `GET /shootdays/today` / `GET /shootdays/tomorrow` — role-shaped response (actor gets only own call + scenes; costume gets costume-relevant slice; etc.)
- `POST /scenes` | `PATCH /scenes/:id` | `PATCH /scenes/reorder`
- `PATCH /scenes/:id/status` — on change, notify roles linked to that scene only

### Actor
- `GET /actors/me/today` — call times, scenes, costume numbers, timeline
- `POST /actors/me/print-request` — creates print_request (idempotent per day), notifies direction roles: "🖨️ {actorName} needs printed script"
- `PATCH /print-requests/:id/done` — admin

### Costume
- `GET /costumes/today` / `GET /costumes/tomorrow` (tomorrow only if published)
- `PATCH /costumes/:id/status` — costume+admin roles; when all costumes of a scene become `ready`, optionally auto-create walkie_event (flag in request `broadcast: true`) and notify direction: "👗 Costumes ready — Scene {n}"

### Props
- `GET /props/today` / `GET /props/tomorrow` / `GET /props` (inventory, filterable)
- `POST /props` | `PATCH /props/:id/status` — art+admin roles; enforce stage order to_purchase→purchased→packed→on_set→returned (allow one step back)

### Walkie
- `POST /walkie` — validate sender role permission matrix:
  - direction roles → all types
  - costume → scene_ready(costume context)/custom
  - art → custom
  - actor → forbidden (403)
  Then create event + push to all crew checked-in today (silent push except lunch_break & pack_up = sound)
- `GET /walkie/today`

### Attendance
- `GET /attendance/qr-token` — admin; returns `{token, expiresAt}` — HMAC-signed token rotating every 60s (`qr.service`): `HMAC(secret, projectId + shootDayId + timeWindow)`
- `POST /attendance/checkin` — body {token}; verify HMAC + time window (±90s grace) → create attendance (unique) → notify production/direction: "✅ {name} arrived"
- `GET /attendance/today` — admin summary

### Script (SECURITY-CRITICAL)
- `POST /script/upload` — admin; full script PDF → `scripts` bucket (server-only access)
- `GET /script/me` — actor: server finds actor's scenes → extracts ONLY those page ranges from the master PDF (use `pdf-lib` to copy pages into a new PDF) → stamps diagonal watermark on every page: "{actorName} • {phone} • SetSync" at 30% opacity → returns as short-lived signed download (or stream). **Never expose the master script fileId to clients.** Cache sliced PDFs per (actor, script version), invalidate on script re-upload.

### Call Sheet
- `GET /callsheet/:shootDayId/pdf` — returns signed URL of generated PDF (team members only)

### Notifications
- `GET /notifications` — targeted to caller (role or userId match), paginated
- `PATCH /notifications/:id/read`

---

## 6. NOTIFICATION SERVICE (fan-out rules — implement exactly)

`notify({projectId, targetRoles?, targetUserIds?, title, body, type, deepLink, sound=false})`
1. Create `notifications` document (Flutter realtime picks it up for in-app bell)
2. Resolve FCM tokens of matching users
3. Send FCM multicast; `sound=false` → data-only/silent priority

| Event | Targets | Sound |
|---|---|---|
| Call sheet published | all crew | ✅ |
| Scene/location/time changed | roles+actors linked to scene | ✅ |
| Costume ready | direction roles | ❌ |
| Print request | direction roles | ❌ |
| Walkie: lunch/pack up | all checked-in | ✅ |
| Walkie: others | all checked-in | ❌ (in-app feed) |
| Actor arrived | direction roles | ❌ |

---

## 7. SCHEDULED JOBS

- **8:00 PM daily (IST):** if tomorrow's shoot_day exists and status=draft → notify admin roles: "⏰ Tomorrow's call sheet is not published yet"
- **Midnight:** mark yesterday's published day `completed`; snapshot simple DPR data (scenes completed vs planned) into a `dpr` collection (structure only — full DPR UI is Phase 2)

---

## 8. SECURITY CHECKLIST

- All writes via server (Appwrite client write permissions disabled)
- Role guard on every route (`requireRole([...])`)
- projectId always derived from authenticated profile, never from client input
- Zod validation on all bodies; 422 with field errors
- Rate limit: walkie 1 event/5s per user; print-request 1/day per actor
- Signed URLs expire ≤ 10 min (script), ≤ 24h (call sheet)
- Secrets via env: `APPWRITE_ENDPOINT, APPWRITE_PROJECT, APPWRITE_API_KEY, FCM_SERVICE_ACCOUNT_JSON, QR_HMAC_SECRET, JWT config`
- CORS locked to app origins; helmet enabled

---

## 9. BUILD ORDER

1. Appwrite provisioning script (`scripts/provision.ts` — creates DB, collections, attributes, indexes, buckets, teams via server SDK; idempotent)
2. Express skeleton + auth middleware + role guards
3. Users/crew endpoints + FCM token save
4. Shoot days + scenes CRUD + **publish workflow with PDF**
5. Notification service + FCM
6. Actor endpoints + print request
7. Costume + props endpoints
8. Walkie endpoints + rate limiting
9. Attendance QR (HMAC rotation)
10. Script slicing + watermarking (pdf-lib)
11. Cron jobs
12. Dockerfile + README (env setup, Appwrite setup steps, run instructions)

## 10. DELIVERABLES EXPECTED FROM THE AGENT

- Full TypeScript Express project as specified
- `scripts/provision.ts` for one-command Appwrite setup
- `templates/callsheet.html` — professional call sheet layout (production title, day/date, call time, location + map link, scene table [Scene | INT/EXT | D/N | Synopsis | Cast], actor call-time table, department notes, emergency contacts footer)
- `.env.example`, Dockerfile, README
- Postman/Thunder Client collection for all endpoints
