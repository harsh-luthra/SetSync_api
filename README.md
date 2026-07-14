# SetSync Backend

Node.js (Express + TypeScript) API server for the SetSync film-production app, backed by **Appwrite** (auth, database, storage, realtime) and **FCM** (push). Implements `Docs/SETSYNC_BACKEND_SPEC.md` (MVP 1.0).

## Architecture

```
Flutter ──auth/realtime/reads──▶ Appwrite
Flutter ──writes & workflows──▶ Node.js API ──server SDK──▶ Appwrite
                                     └──────▶ FCM push
```

- Clients authenticate with Appwrite and send their **Appwrite JWT** as `Authorization: Bearer <jwt>` to this API.
- All database **writes** go through this server (Appwrite collections have no client write permissions; documents get team-based read permissions only).
- `projectId` is always derived from the authenticated profile — never from request input.

## Prerequisites

- Node.js 20+
- An Appwrite project (Cloud or self-hosted) + an **API key with full scopes** (databases, storage, users, teams)
- Optional: a Firebase service account JSON for FCM push

## Setup

```bash
npm install
cp .env.example .env      # fill in Appwrite endpoint/project/API key + QR_HMAC_SECRET
```

### 1. Provision Appwrite (one command, idempotent)

```bash
npm run provision
```

Creates the `setsync_db` database, all 12 collections with attributes + indexes (including the unique `(shootDayId, userId)` attendance index), and the `scripts` / `callsheets` / `avatars` buckets.

**Optional seeding:** set `SEED_PROJECT_TITLE`, `SEED_DIRECTOR_NAME`, `SEED_DIRECTOR_PHONE` in `.env` before running — this creates the first project, its Appwrite team (`team_{projectId}`), and a director invite so the director's first login auto-links via `/auth/bootstrap`.

**Manual step (Appwrite console):** enable **Phone (OTP)** and **Email/Password** auth methods.

### 2. Run

```bash
npm run dev     # tsx watch mode
# or
npm run build && npm start
```

Health check: `GET http://localhost:3000/health`

### 3. Docker

```bash
docker build -t setsync-api .
docker run --env-file .env -p 3000:3000 setsync-api
```

The image installs Chromium for puppeteer (call-sheet PDF rendering).

## Onboarding flow

1. Admin (director) exists via provision seeding, or invite crew with `POST /api/v1/crew/invite` `{phone, name, role}`.
2. Crew member logs in to Appwrite (phone OTP) in the Flutter app, creates a JWT, and calls `POST /api/v1/auth/bootstrap` — the profile is matched by phone, linked, and the user is added to the project team (enabling direct Appwrite reads/realtime).
3. App saves the device token via `POST /api/v1/users/fcm-token`.

## API overview (`/api/v1`, JWT required)

| Area | Endpoints |
|---|---|
| Auth & users | `POST /auth/bootstrap` (returns `needsSetup`/`isMaster` flags), `POST /users/fcm-token`, `POST /crew/invite` (with email+password → creates the sign-in account instantly; phone-only → legacy OTP pre-registration), `GET /crew` |
| Master admin | `POST /master/directors` (register director account), `GET /master/directors`, `PATCH /master/directors/:authUserId/password` (reset) — caller's email must be in `MASTER_ADMIN_EMAILS` |
| Password reset | `POST /crew/:id/reset-password` — direction roles; only the director may reset another direction-role account; target's sessions are revoked |
| Crew management | `PATCH /crew/:id` `{active?, name?, role?}` — deactivation revokes sessions and blocks all API access; only the director may touch direction-role members |
| Avatars | `POST /users/me/avatar` (multipart `file`, jpg/png/webp ≤5 MB) → public `avatarUrl` |
| Jobs | `POST /jobs/run/:job` (`tomorrowReminder` \| `midnightWrap`) — master JWT or `X-Cron-Secret` header; use with cron-job.org on hosts that sleep (Render free) |
| Projects | `POST /projects` (in-app project setup, replaces SEED_* vars), `GET /projects/me`, `PATCH /projects/me` |
| Shoot days | `POST /shootdays`, `PATCH /shootdays/:id`, `POST /shootdays/:id/publish`, `GET /shootdays/today\|tomorrow` (role-shaped) |
| Scenes | `POST /scenes`, `PATCH /scenes/:id`, `PATCH /scenes/reorder`, `PATCH /scenes/:id/status`, `DELETE /scenes/:id` |
| Actor calls | `GET /actor-calls?shootDayId=`, `POST /actor-calls` (upsert by shootDayId+actorId), `PATCH /actor-calls/:id`, `DELETE /actor-calls/:id` |
| Actor | `GET /actors/me/today`, `POST /actors/me/print-request`, `PATCH /print-requests/:id/done` |
| Costumes | `GET /costumes/today\|tomorrow`, `POST /costumes`, `PATCH /costumes/:id`, `PATCH /costumes/:id/status` (`broadcast` flag) |
| Props | `GET /props[/today\|/tomorrow]`, `POST /props`, `PATCH /props/:id/status` (stage order enforced) |
| Walkie | `POST /walkie` (role matrix, 1/5s rate limit), `GET /walkie/today` |
| Attendance | `GET /attendance/qr-token` (rotating 60s HMAC), `POST /attendance/checkin`, `POST /attendance/checkin/manual`, `GET /attendance/today` |
| Script | `POST /script/upload` (admin, multipart `file`), `GET /script/me` (actor — watermarked slice of own scenes only) |
| Call sheet | `GET /callsheet/:shootDayId/pdf` → signed 24h URL; `GET /callsheet/:shootDayId/download` (signature-authenticated) |
| Notifications | `GET /notifications?limit=&offset=`, `PATCH /notifications/:id/read` |

A ready-made collection is in [postman/SetSync.postman_collection.json](postman/SetSync.postman_collection.json) (works in Postman and Thunder Client). Set `baseUrl` and `jwt` variables.

### The publish workflow

`POST /shootdays/:id/publish`:
1. Validates every scene has actors and every actor has an `actor_calls` entry (422 with a human-readable `issues` list otherwise)
2. Sets `status=published`
3. Renders `src/templates/callsheet.html` → PDF (puppeteer) → uploads to `callsheets` bucket
4. Notifies **all** crew ("📋 Call sheet for Day {n} … — Call time {time}", sound)

## Scheduled jobs (IST)

- **20:00** — if tomorrow's shoot day is still `draft`, remind direction roles.
- **00:00** — mark yesterday's `published` day `completed` and write a DPR snapshot (scenes completed vs planned) to the `dpr` collection.

## Security notes

- Role guard on every route; walkie 1 event/5s per user; print request idempotent per day.
- Attendance QR: `HMAC(secret, projectId|shootDayId|timeWindow)`, 60s rotation, ±90s grace.
- Master script never leaves the server; actors get per-scene page slices watermarked `{name} • {phone} • SetSync` at 30% opacity, cached per (actor, script version).
- Signed URLs: script is streamed directly (no URL); call sheet links expire in 24h.
- Helmet enabled; lock `CORS_ORIGINS` down in production.

## Implementation notes / small deviations from the spec

- `POST /costumes` + `PATCH /costumes/:id` and `POST /attendance/checkin/manual` are not enumerated in spec §5 but are required to make the data model usable (costume inventory creation, manual attendance fallback). Both are role-guarded per the same rules.
- Appwrite JWTs are verified by calling Appwrite (`Account.get` with the JWT-bound client) — the authoritative check; `jsonwebtoken` is used only to fast-reject expired tokens.
- Projects/teams are created by the provision seeding step (the MVP API has no project-creation endpoint, per spec).
