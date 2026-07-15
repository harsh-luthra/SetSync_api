# SetSync — Flutter App ↔ Backend Handoff (complete)

Single source of truth for the app agent. Backend is deployed and live-tested.

## 0. Base configuration

- **API base URL:** `https://setsync-api.onrender.com/api/v1` (dev fallback: `http://10.0.2.2:3000/api/v1` on Android emulator, LAN IP on real device)
- Free-tier host sleeps when idle → first request after ~15 min idle takes up to ~30 s. Add a patient splash/retry on app launch; do NOT treat the timeout as "server down".
- **Appwrite:** endpoint `https://sgp.cloud.appwrite.io/v1`, project `6a558fba001afd050ea8`, database `6a55900b00037bbfebf6`. The app uses the Appwrite SDK ONLY for: login, `account.createJWT()`, and Realtime subscriptions. All reads/writes of app data go through the API.

## 1. Auth — email + password ONLY (phone OTP is parked for a future release)

Login flow for every user type:
1. `account.createEmailPasswordSession(email, password)` (Appwrite SDK)
2. `account.createJWT()` → send on EVERY API call as `Authorization: Bearer <jwt>`
3. JWTs expire in ~15 min — refresh by calling `createJWT()` again (e.g. on 401, or proactively every ~10 min while active)
4. `POST /auth/bootstrap` → route the app:

```json
{ "profile": {...}|null, "created": bool, "needsSetup": bool, "isMaster": bool }
```
- `isMaster: true` → Master dashboard
- `needsSetup: true` → Create Project screen (director's first login)
- `profile: {...}` → main app; `profile.role` picks the shell:
  `director | associate_director | assistant_director` (= "direction/admin"), `actor`, `costume`, `art`
- "Forgot password?" → static guidance: crew ask their AD; directors ask the master. NO email recovery exists.
5. After login: `POST /users/fcm-token` `{token}` with the FCM device token (re-send on token refresh).

**Phone number stays as a FIELD everywhere (invites, profiles) — never as a login method.**

## 2. Shared API conventions

- IDs: `actorId` / `userId` / crew `id` = the **users-collection document $id** (from `GET /crew` or bootstrap `profile.$id`) — NEVER the Appwrite auth account id.
- Times of day: strings `"HH:mm"` (24h). Dates: ISO 8601 with offset, e.g. `"2026-07-15T00:00:00+05:30"`. Production timezone is IST.
- Errors: always JSON. 422 validation → `{message, errors:[{field,message}]}`; other errors → `{message, details?}`. One shared parser covers all.
- 401 = JWT invalid/expired (refresh JWT, retry once, else re-login). 403 = role not allowed (hide the action). 404 on `/shootdays/today|tomorrow` = no (published) day — show empty state, not an error.

## 3. Screens by role

### 3a. Master dashboard (`isMaster`)
- List: `GET /master/directors` → `{directors:[{authUserId,name,email,phone,hasProject,projectId}]}`; badge "Active" vs "Awaiting project setup".
- Register director: `POST /master/directors` `{name,email,phone,password(≥8)}` → 201. Show "share credentials" card (only time password is visible). 409 = email/phone already registered.
- Reset director password: `PATCH /master/directors/:authUserId/password` `{password}` → target is logged out everywhere.

### 3b. Create Project (director, `needsSetup`)
`POST /projects`:
```json
{ "title": "...", "productionHouse": "...", "directorName": "...", "directorPhone": "+91-...",
  "startDate": "2026-07-15T00:00:00+05:30", "endDate": "..." }
```
(title, directorName, directorPhone required) → 201 `{project, profile}` → go straight to app home. Make this beautiful — a director's first moment. Two-step form + success state suggested.
- Project settings later: `GET /projects/me`, `PATCH /projects/me` `{title?,productionHouse?,status? (prep|shooting|wrapped),startDate?,endDate?}` (direction only). Include a status switcher.

### 3c. Direction (admin) screens
- **Day editor:** `POST /shootdays` `{date,dayNumber,generalCallTime,locationName,locationMapUrl?,generalNotes?}`; `PATCH /shootdays/:id`.
- **Scene editor:** `POST /scenes` `{shootDayId,sceneNumber,intExt,dayNight,locationName,synopsis?,actorIds[],scriptPageStart,scriptPageEnd}`; `PATCH /scenes/:id`; `PATCH /scenes/reorder` `{items:[{sceneId,order}]}`; `PATCH /scenes/:id/status` `{status: pending|ready|shooting|completed}`; `DELETE /scenes/:id`.
  Page-range validation: `GET /projects/me` → `project.scriptPageCount` (null until a script is uploaded). Cap the page pickers at it and label "of N pages"; warn if no script uploaded yet.
- **Actor-call editor:** `GET /actor-calls?shootDayId=`; `POST /actor-calls` (UPSERT by shootDayId+actorId — one Save button, call repeatedly) `{shootDayId,actorId,pickupTime?,callTime?,makeupTime?,hairTime?,onSetTime?,lunchTime?,sceneIds?}`; `PATCH /actor-calls/:id`; `DELETE /actor-calls/:id`.
- **Publish (two-step UX):**
  1. Preview: `GET /shootdays/:id/callsheet-preview` — streams the EXACT call-sheet PDF (JWT header needed; changes nothing, notifies no one). The `X-Publish-Issues` response header carries a URL-encoded JSON array of human-readable blockers (empty array = publishable) — decode and show as a checklist next to the preview, with the Publish button disabled while non-empty.
  2. Publish: `POST /shootdays/:id/publish`. 422 → same checklist in `details.issues`. Success = PDF stored + push to all crew.
- **Print queue (direction):** `GET /print-requests` → `{printRequests:[{$id,actorName,status,$createdAt,shootDayId}], pendingCount}` (defaults to pending; `?status=done|all`, `?shootDayId=`). Mark done: `PATCH /print-requests/:id/done`. Show `pendingCount` as a badge on the direction home screen.
- **Crew:** `GET /crew` → `{crew:[{id,name,phone,email,role,active,linked,avatarFileId,checkedInToday}]}`.
  - Invite: `POST /crew/invite` `{name,phone,role,email,password}` — ALWAYS send email+password (creates the sign-in account instantly, pre-verified). Show share-credentials card. 409 inline on duplicate.
  - Manage: `PATCH /crew/:id` `{active?,name?,role?}` — deactivate (confirm: "signed out + loses access immediately"), reactivate, rename, change role. 422 = own row (hide action), 403 = non-director touching direction roles (disable).
  - Reset password: `POST /crew/:id/reset-password` `{password}` → share-credentials card. 409 = no account yet (offer re-invite).
- **Attendance:** `GET /attendance/qr-token` → `{token,expiresAt}` — render as QR, re-fetch every ~50 s. Summary: `GET /attendance/today`. Manual fallback: `POST /attendance/checkin/manual` `{userId}`.
- **Script upload:** `POST /script/upload` multipart `file`, PDF ≤50 MB → `{scriptVersion, scriptPageCount}` (show "92 pages · v3" as confirmation). Re-upload = new version (actors' cached slices regenerate automatically). 422 = not a readable PDF.
- **Print requests:** notification deep-links; `PATCH /print-requests/:id/done`.
- **Today/Tomorrow overview:** `GET /shootdays/today|tomorrow` → direction gets `{shootDay, scenes, actorCalls}` (drafts visible to direction only).

### 3d. Actor screens
- **My day:** `GET /actors/me/today` → `{shootDay, call, scenes, costumes, timeline:[{label,time}]}` (timeline pre-sorted).
- **My script:** `GET /script/me` — **streams PDF bytes** (needs JWT header; NOT a URL). Save to temp file → display in PDF viewer. First fetch can take seconds (server slices + watermarks) → loader. 404 body explains (no script yet / no scenes).
- **Print request:** `POST /actors/me/print-request` — idempotent per day (`created:false` = already requested → show state, not error).
- **Check-in scanner:** scan admin QR → `POST /attendance/checkin` `{token}`. 200 + `alreadyCheckedIn:true` = friendly "already in". 401 = stale code ("scan the fresh one").
- Actors have NO walkie send UI (server 403s it) — feed is read-only for them.

### 3e. Costume / Art screens
- Costume: `GET /costumes/today|tomorrow` (tomorrow 404s until published) → `{shootDay,scenes,costumes}`; `POST /costumes` `{actorId,sceneIds,costumeNumber,lookDescription?,accessories[],tomorrowReady?}`; `PATCH /costumes/:id`; `PATCH /costumes/:id/status` `{status: pending|ready|on_actor|laundry|repair, broadcast?:bool}` — when the last costume of a scene turns ready, response includes `scenesFullyReady:["12A"]`; offer a "Broadcast scene ready" toggle (sends walkie event when true).
- Art: `GET /props/today|tomorrow`; inventory `GET /props?status=&q=`; `POST /props` `{name,quantity,sceneIds?,notes?,neededDate?}`; `PATCH /props/:id/status` `{status}` — stage order ENFORCED one step forward/back: to_purchase→purchased→packed→on_set→returned (422 explains) → render as a stepper, not a free dropdown.

### 3f. Shared screens
- **Account / profile screen (ALL roles — identity is mandatory UX):**
  `GET /users/me` → `{profile, project:{id,title,productionHouse,status}|null, avatarUrl|null, isMaster}`.
  Show: avatar (tap to change via `POST /users/me/avatar`), name, role badge, phone, email, project title + production house + status chip, and a **Logout** button (delete Appwrite session + clear local state). Also put a persistent identity chip in the app header/drawer on every screen: avatar + first name + role badge, tapping it opens this screen. Role badge colors suggested: direction = red/amber, actor = blue, costume = purple, art = green.
- **Walkie feed:** load `GET /walkie/today`; live via Appwrite Realtime channel
  `databases.6a55900b00037bbfebf6.collections.walkie_events.documents`.
  Send (direction all types; costume: scene_ready/custom; art: custom): `POST /walkie` `{type,message?}`; types: scene_ready|artist_ready|camera_ready|lunch_break|pack_up|custom. 429 = rate limit → disable send 5 s. 409 = no published day today ("walkie offline").
- **Notifications bell:** `GET /notifications?limit=25&offset=0` (items include computed `read`); realtime channel `databases.6a55900b00037bbfebf6.collections.notifications.documents` (client filter: `targetRoles` has my role OR `targetUserIds` has my id); `PATCH /notifications/:id/read` on tap. FCM data payload carries `{type, deepLink, title, body, notificationId}`; deep links look like `setsync://shootday/<id>`, `setsync://scene/<id>`, `setsync://walkie/<id>`, `setsync://attendance/<id>`, `setsync://print-request/<id>`.
- **Call sheet viewer:** `GET /callsheet/:shootDayId/pdf` → `{url, expiresAt}` — signed URL, open WITHOUT auth header (valid 24 h).
- **Avatar:** `POST /users/me/avatar` multipart `file` (jpg/png/webp ≤5 MB) → `{profile, avatarUrl}` (public, no auth). Others' avatars: `https://sgp.cloud.appwrite.io/v1/storage/buckets/scripts/files/{avatarFileId}/view?project=6a558fba001afd050ea8`.

## 4. Realtime (Appwrite SDK, same logged-in client)

Channels: `databases.6a55900b00037bbfebf6.collections.<collection>.documents` for `walkie_events`, `notifications`, `scenes` (live scene-status board), `shoot_days`. Team read permissions are already in place — membership is automatic.

## 5. Test accounts (all email+password, live)

| Who | Email | Password | Context |
|---|---|---|---|
| Master | master@setsync.test | Master#2026 | Master dashboard |
| Director | director@setsync.test | SetSync#2026 | Project "Pabesto_ka_Dhanda" |
| Actor | asha.actor@setsync.test | NewPass#2026 | Same project |
| Director (own project) | demo.director@setsync.test | NewDir#2026 | Project "Demo Film Two" |

Fresh JWT for API tools any time: `npx tsx scripts/mint-jwt.ts <email>` (backend repo). Postman collection: `postman/SetSync.postman_collection.json`.

## 6. Build order (recommended)

1. Login + bootstrap routing (+ JWT refresh interceptor + FCM token save)
2. Master dashboard + Create Project
3. Day editor → Scene editor → Actor-call editor → Publish (with the 422 checklist dialog)
4. Crew screen (invite / manage / reset password)
5. Actor: my day + script viewer + print request
6. Attendance QR (admin display + crew scanner + summary)
7. Costume + Art screens
8. Walkie feed + notifications bell + call sheet viewer + avatars
