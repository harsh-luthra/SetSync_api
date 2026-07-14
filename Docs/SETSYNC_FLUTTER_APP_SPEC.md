# SetSync — Flutter Mobile App Specification
### Film Production Management App (Android + iOS)
**Version:** MVP 1.0
**Target:** Flutter (single codebase for Android & iOS), built in Android Studio
**Backend:** Node.js API + Appwrite (separate document — do NOT build backend logic here; consume REST APIs and Appwrite SDK only)

---

## 1. PRODUCT OVERVIEW

SetSync is a film-set coordination app that replaces paper call sheets, walkie-talkie chaos, and WhatsApp confusion on Indian film/OTT shoots.

**Core concept:** One central project database. Every department logs in and sees ONLY its own role-based dashboard, but all data comes from the same source. When the Direction team updates anything (schedule, scene, location, timing), every concerned department's panel updates in real time.

**One-line pitch:** "Update once, everyone's panel syncs instantly."

---

## 2. MVP SCOPE (BUILD ONLY THIS — DO NOT BUILD PHASE 2+ FEATURES)

### Included in MVP:
1. **Auth + Role-based login** (Appwrite Auth)
2. **Direction/AD Panel** (admin) — create & publish call sheets, schedules, scenes
3. **Actor Panel** — personal schedule, call time, scenes, script viewer, "Need Printed Script" button
4. **Costume Panel** — scene-wise costume checklist, statuses
5. **Art/Props Panel** — props checklist with 4-stage status
6. **Walkie Replacement** — quick status broadcast buttons (KILLER FEATURE — highest priority)
7. **Push notifications** (FCM via backend) — role-filtered
8. **QR Attendance** — crew scans QR at set, attendance marked
9. **Call Sheet as PDF** — view, share, print
10. **Script security** — actor sees only his/her scenes, watermarked with their name
11. **Read-only offline cache** — last synced call sheet/schedule visible without internet

### Explicitly EXCLUDED from MVP (do not build):
- In-app chat (use WhatsApp deep links instead)
- Live GPS vehicle tracking
- Budget module
- Full offline write-sync
- Camera/Sound/Makeup/Transport/Spot/Catering panels (Phase 2)
- AI features

---

## 3. USER ROLES (MVP)

| Role | Access Level |
|------|-------------|
| `director` | Admin — full read/write |
| `associate_director` | Admin — full read/write |
| `assistant_director` | Admin-lite — can update statuses, publish call sheets, cannot delete project |
| `actor` | Own schedule, own scenes, own script pages only |
| `costume` | Costume dashboard, scene/actor costume data |
| `art` | Props dashboard, scene props data |

Role comes from the backend on login (`user.role` + `user.projectId`). The app renders the panel based on role. One user = one role per project.

---

## 4. APP ARCHITECTURE

- **State management:** Riverpod (preferred) or Bloc — pick Riverpod for simplicity
- **Navigation:** go_router with role-based redirect after login
- **Networking:** dio for Node.js REST API + appwrite Flutter SDK for auth/realtime/storage
- **Realtime:** Appwrite Realtime subscriptions on collections (callsheets, scenes, statuses, notifications)
- **Local cache:** hive or drift — cache last call sheet, schedule, script pages for offline read
- **Push:** firebase_messaging (FCM)
- **PDF:** printing + pdf packages for call sheet render/share/print
- **QR:** mobile_scanner (scan) + qr_flutter (generate, admin side)

### Suggested folder structure:
```
lib/
├── main.dart
├── app/
│   ├── router.dart              # go_router, role-based redirects
│   ├── theme.dart               # design system (Section 6)
│   └── constants.dart
├── core/
│   ├── api/                     # dio client, endpoints, interceptors
│   ├── appwrite/                # appwrite client, realtime service
│   ├── cache/                   # hive boxes, offline cache service
│   ├── notifications/           # FCM setup, local notifications
│   └── models/                  # User, Project, Scene, CallSheet, Costume, Prop, etc.
├── features/
│   ├── auth/                    # login, role resolution
│   ├── direction/               # admin panel
│   ├── actor/                   # actor panel
│   ├── costume/                 # costume panel
│   ├── art/                     # props panel
│   ├── walkie/                  # status broadcast (shared widget + full screen)
│   ├── attendance/              # QR scan/generate
│   ├── callsheet/               # PDF view/share/print
│   └── script/                  # secure script viewer
└── shared/
    └── widgets/                 # cards, chips, status badges, empty states
```

---

## 5. DATA MODELS (mirror of backend schema — see backend doc)

```dart
User        { id, name, phone, email, role, projectId, avatarUrl, fcmToken }
Project     { id, title, productionHouse, startDate, endDate, status }
ShootDay    { id, projectId, date, dayNumber, callTime, location, locationMapUrl,
              status: draft|published|completed, generalNotes }
Scene       { id, projectId, shootDayId, sceneNumber, intExt, dayNight, locationName,
              synopsis, actorIds[], costumeIds[], propIds[], scriptPageRange,
              status: pending|ready|shooting|completed, order }
ActorCall   { id, shootDayId, actorId, pickupTime, callTime, makeupTime, hairTime,
              onSetTime, sceneIds[] }
Costume     { id, projectId, actorId, sceneIds[], costumeNumber, lookDescription,
              accessories[], status: pending|ready|on_actor|laundry|repair,
              tomorrowReady: bool }
Prop        { id, projectId, sceneIds[], name, quantity, notes,
              status: to_purchase|purchased|packed|on_set|returned,
              neededDate }
WalkieEvent { id, projectId, shootDayId, type: scene_ready|artist_ready|camera_ready|
              lunch_break|pack_up|custom, message, senderId, senderRole, timestamp }
Attendance  { id, projectId, shootDayId, userId, checkInTime, method: qr|manual }
PrintRequest{ id, actorId, shootDayId, status: requested|done, timestamp }
Notification{ id, projectId, targetRoles[], targetUserIds[], title, body, type, timestamp, read }
```

---

## 6. DESIGN SYSTEM (UI/UX — VERY IMPORTANT, FOLLOW STRICTLY)

The app must look premium and cinematic, NOT like a generic admin template. It will be used on real film sets, often at night, outdoors, in a hurry.

### Visual identity
- **Theme:** Dark-first. Film sets shoot at night; dark UI saves battery and eyes. Provide light theme as secondary.
- **Background:** Deep charcoal `#0E0E12` with subtle radial gradient panels `#16161D`
- **Primary accent:** Cinema amber `#F5A623` (like tungsten set lights) — for CTAs, active states
- **Secondary accent:** Signal red `#E5484D` — recording/urgent states only
- **Success:** `#30C567` | **Info:** `#4C9AFF`
- **Typography:** Montserrat (headings, bold 700/800) + Inter (body). Big, readable sizes — minimum 14sp body, 18-22sp for call times and scene numbers. People read this on a chaotic set — clarity over density.
- **Cards:** Rounded 16px, subtle 1px border `#26262E`, soft elevation
- **Status chips:** Pill-shaped, color-coded, always with icon + label (never color alone)

### UX principles
1. **Two-tap rule:** Any daily action (mark costume done, tap walkie button, check tomorrow's call time) must be reachable in ≤2 taps from home.
2. **Today-first:** Every panel opens on TODAY's data. Tomorrow is one swipe/tab away.
3. **Giant touch targets:** Walkie buttons and status toggles minimum 56dp height — crew wears gloves, holds equipment.
4. **Skeleton loaders,** never blank screens. Offline banner (amber strip) when showing cached data: "Showing last synced • 8:42 PM".
5. **Haptic feedback** on walkie buttons and status changes.
6. **Empty states with personality:** e.g., "No scenes scheduled yet. Chai break? ☕"

---

## 7. SCREENS — DETAILED SPEC

### 7.1 Auth Flow
- **Splash** → logo animation (film slate clap) → auto-login if session exists
- **Login:** Phone number + OTP (Appwrite phone auth) — crew members are not email people. Fallback: email+password.
- **Role resolution:** After login, fetch user profile → route to role's home. If user has no project assigned → "Waiting for production to add you" screen with refresh.

### 7.2 Shared Shell (all roles)
- Bottom nav (max 4 tabs, varies by role)
- Persistent **Walkie FAB** (floating action button, amber, slate icon) on every screen for roles that can broadcast; actors see walkie feed read-only
- Top bar: project title + day badge ("Day 14/45") + notification bell with unread count

### 7.3 Direction/AD Panel (Admin)
**Tabs:** Today | Schedule | Departments | More

**Today tab:**
- Live scene board: ordered scene cards for today with status (pending → ready → shooting → completed), drag to reorder
- Tap scene → edit sheet: location, timing, actors, costumes, props, notes
- "Publish Tomorrow's Call Sheet" prominent button (evening workflow) → confirmation → pushes notification to ALL crew
- Walkie feed strip: last 3 status broadcasts

**Schedule tab:**
- Calendar view (table_calendar package), color-coded days (shoot/travel/off)
- Tap day → shoot day editor: general call time, location (with map link), scene list, per-actor call times (pickup/makeup/hair/on-set)

**Departments tab:**
- Grid of department cards with live status summary:
  - Costume: "6/8 ready" progress ring
  - Art: "12/15 props on set"
  - Actors: "3/5 arrived" (from attendance)
- Tap card → drill into that department's full status (read-only view of their panel)
- **Print Requests section:** list of actors who tapped "Need Printed Script" — mark as done

**More tab:** Attendance QR generator (full-screen QR for today, crew scans it), crew list, project settings

### 7.4 Actor Panel
**Tabs:** Today | Script | Calendar

**Today tab (hero screen — make it beautiful):**
- Big hero card: **CALL TIME 7:00 AM** (huge amber type), pickup time, location with "Open in Maps" button
- Timeline strip: Pickup 6:15 → Makeup 7:00 → Hair 7:40 → On Set 8:30 → Lunch 1:00
- "My Scenes Today" cards: scene number, synopsis one-liner, costume number chip, status
- Tomorrow preview card (appears after AD publishes): "Tomorrow: Call 6:30 AM, 3 scenes"

**Script tab:**
- Shows ONLY this actor's scenes (backend enforces; app never downloads full script)
- Rendered as scrollable pages with **diagonal watermark of actor's name + phone** on every page (Flutter CustomPaint overlay). Disable screenshots on Android (`FLAG_SECURE`); on iOS show watermark prominently since screenshot blocking isn't possible.
- **"Need Printed Script" button** at bottom → confirm dialog → sends PrintRequest → snackbar "AD team notified 👍". Button becomes "Requested ✓" (disabled) until AD marks done.

**Calendar tab:** actor's own shoot days only, color-coded.

### 7.5 Costume Panel
**Tabs:** Today | Tomorrow | Wardrobe

**Today tab:**
- Grouped by actor: card per actor → costume number, look description, accessories checklist, scene chips, location
- Status segmented control per costume: Pending → Ready → On Actor
- Swipe actions: mark Laundry / Repair (moves to Wardrobe tab lists)
- When all costumes for a scene are Ready → auto walkie event "Costumes ready for Scene X" (with confirm)

**Tomorrow tab:**
- Auto-generated prep list from tomorrow's published scenes: every costume needed tomorrow with "Ready for tomorrow ✓" checkbox
- Banner if tomorrow's call sheet not yet published: "Waiting for AD to publish tomorrow's schedule"

**Wardrobe tab:** full costume inventory, Laundry Pending list, Repair Required list

### 7.6 Art/Props Panel
**Tabs:** Today | Tomorrow | Inventory

**Today tab:**
- Props grouped by scene. Each prop row: name, qty, notes, and a 4-stage horizontal stepper: **Purchased → Packed → On Set → Returned** (tap to advance, long-press to go back)
- Scene header shows progress: "Scene 42 — 5/7 props on set"

**Tomorrow tab:** auto-generated list of props needed tomorrow (from published scenes) — the "never forget props" list. Checkbox "Packed for tomorrow".

**Inventory tab:** master props list, filter by status, add new prop (name, qty, scenes, needed date).

### 7.7 Walkie Screen (shared, opens from FAB)
- Full-screen grid of giant buttons (2 columns, 96dp height):
  - 🎬 **SCENE READY** | 🧑‍🎤 **ARTIST READY**
  - 📷 **CAMERA READY** | 🍛 **LUNCH BREAK**
  - 🏁 **PACK UP** | ✏️ **CUSTOM** (short text input)
- Tap → haptic + confirm bottom sheet ("Broadcast SCENE READY to crew?") → sends WalkieEvent
- Below buttons: live feed of today's events (realtime), newest first, with sender role chip and time
- Who can broadcast what (enforce in UI + backend): Direction/AD → all; Costume → "Costumes Ready"; Art → "Props On Set"; Actors → read-only feed

### 7.8 Attendance
- Crew side: "Scan Attendance QR" button on More/profile → camera scanner → success animation + check-in time
- Admin side: generates a rotating QR (token refreshes every 60s to prevent photo-sharing cheating — token from backend)

### 7.9 Call Sheet PDF
- "View Call Sheet" on every role's Today screen → rendered PDF (from backend-generated PDF URL, cached locally)
- Actions: Share (share_plus), Print (printing package), Download

### 7.10 Notifications
- Bell icon → notification center list (grouped by day)
- Push notification tap → deep-link to relevant screen (e.g., "Tomorrow's call sheet published" → Today/Tomorrow view)
- **Notification rules (respect strictly to avoid spam):**
  - Call sheet published → everyone
  - Scene/location/time changed → only roles linked to that scene
  - Costume ready → Direction only
  - Print request → Direction/AD only
  - Walkie events → everyone on today's shoot (silent notification + in-app feed, sound only for PACK UP and LUNCH)

---

## 8. REALTIME BEHAVIOR

Subscribe via Appwrite Realtime to:
- `shoot_days` + `scenes` (current project) → refresh Today boards live
- `walkie_events` (today) → live feed
- `costumes`, `props` → live progress rings on Direction's Departments tab
- `notifications` (targeted) → bell badge

On reconnect after offline: full refetch of today + tomorrow, then resubscribe.

---

## 9. OFFLINE (READ-ONLY MVP)

- Cache in Hive after every successful fetch: today's + tomorrow's call sheet, actor's script pages, costume/props lists
- No connectivity → show cached data + amber banner "Offline — last synced 8:42 PM"
- All write actions disabled with tooltip "Reconnect to update"

---

## 10. FLUTTER PACKAGES (pubspec)

```yaml
dependencies:
  flutter_riverpod, go_router, dio, appwrite,
  firebase_core, firebase_messaging, flutter_local_notifications,
  hive, hive_flutter, connectivity_plus,
  mobile_scanner, qr_flutter,
  pdf, printing, share_plus,
  table_calendar, google_fonts, flutter_animate,
  cached_network_image, url_launcher, intl
```

---

## 11. BUILD ORDER (follow this sequence)

1. Theme + design system + shared widgets (status chips, cards, empty states)
2. Auth flow + role routing
3. Data models + API client + Appwrite client (point to backend doc's endpoints)
4. Direction Panel: shoot day editor + publish flow
5. Actor Panel: Today + notifications receive
6. Walkie feature (both broadcast + feed)
7. Costume Panel
8. Art Panel
9. Script viewer with watermark + print request
10. QR attendance
11. Call sheet PDF actions
12. Offline cache layer
13. Polish: animations (flutter_animate), haptics, skeletons

## 12. QUALITY BAR

- 60fps scrolling on mid-range Android (this is the Indian market)
- App size < 40MB
- Every screen handles: loading, empty, error, offline states
- Hindi-friendly: keep UI text short and simple English (crew is bilingual); structure strings for future localization (use arb files from day 1)
