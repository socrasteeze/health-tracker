# CLAUDE.md — Repo Briefing

## Mission

Daily health log PWA for a diabetic, post-kidney-transplant patient. Self-hosted on the operator's TerraMaster NAS. **One patient, one or two reviewers.** Family-care tool, not HIPAA infrastructure.

## Stakes

Medical-adjacent. The patient takes insulin against a doctor-prescribed sliding scale. This app **never recommends doses to the patient.** It logs what was prescribed (reviewer-only), what was taken, and flags the delta for human review. Any change that lets the patient see or auto-act on the scale is a regression — flag it before proceeding.

## Stack

- Node 20 + Express + better-sqlite3 + node-cron + web-push
- Vanilla HTML / CSS / JS frontend, no build step
- Docker (Alpine), Cloudflare Tunnel for HTTPS
- One SQLite file at `/data/health.db`

## Layout

```
server/
  server.js      Express routes + token auth middleware
  db.js          SQLite schema + helpers (newToken, expectedInsulin)
  push.js        web-push helper (VAPID)
  scheduler.js   node-cron jobs for prompts, reminders, miss alerts
public/
  index.html / app.js            Patient PWA
  reviewer.html / reviewer.js    Reviewer dashboard
  styles.css                     Shared
  sw.js                          Service worker (push + offline shell)
  manifest.webmanifest
scripts/
  generate-keys.js   VAPID keypair generator
  add-user.js        User CLI (patient | reviewer | list | delete)
Dockerfile / docker-compose.yml / .env.example / README.md
```

## Schedule (America/Los_Angeles, fixed)

| Time | Slot      | Asks for                  |
|------|-----------|---------------------------|
| 0700 | weight    | weight only               |
| 0800 | breakfast | glucose, insulin, food    |
| 1200 | lunch     | glucose, insulin, food    |
| 1800 | dinner    | glucose, insulin, food    |
| 2000 | bedtime   | glucose only              |

**Miss logic:** T+0 prompt → T+30 reminder to patient → T+60 alert to reviewers + marked missed in `missed` table.

## Invariants — do not violate without explicit confirmation

1. **Sliding scale is reviewer-only.** Never render it in the patient view. `expectedInsulin()` lands in the DB and the deviation flag, never returned to a patient-token client.
2. **No dose recommendations to patient.** The patient enters what they took. Period.
3. **Time zone is fixed Pacific.** Do not switch to device-local without operator sign-off — the schedule is contractual.
4. **Bedtime slot has no food or insulin field.** Nighttime basal is handled by separate prescription, outside this app's scope.
5. **One patient maximum.** `add-user.js` enforces this. Reviewers unbounded.
6. **Patient never sees missed-check-in flags or deviation flags.** Reviewer dashboard only.
7. **Auth = magic-link token (24 random bytes) in URL query, persisted to localStorage.** No passwords, no user-side login UI. Do not introduce one without asking.
8. **API endpoints under `/api/` are role-gated by middleware.** Patient role cannot read reviewer endpoints. Maintain the `auth(['patient'])` / `auth(['reviewer'])` discipline on any new route.

## Data model

```
users       (id, role: patient|reviewer, name, email, token, created_at)
weights     (id, user_id, date, weight_lb, logged_at) — UNIQUE(user_id, date)
readings    (id, user_id, date, slot, time, glucose, insulin_units,
             food, scale_expected, scale_flag, logged_at)
scale       (id, user_id, from_glucose, to_glucose, units)
missed      (id, user_id, date, slot, notified_reviewer, created_at)
            — UNIQUE(user_id, date, slot)
push_subs   (id, user_id, endpoint, p256dh, auth, created_at)
prompt_log  (id, user_id, date, slot, sent_at) — UNIQUE(user_id, date, slot)
settings    (key, value)
```

## Common modifications

| Task                          | Touch                                                                |
|-------------------------------|----------------------------------------------------------------------|
| Change schedule times         | `SLOTS` in `server/scheduler.js`, restart container                  |
| Change deviation tolerance    | `Math.abs(ins - expected) >= 0.5` in `server/server.js`              |
| Change glucose range colors   | `RANGE_LO` / `RANGE_HI` in `public/app.js`                           |
| Change time zone              | `TZ` const in `scheduler.js` + `TZ` env in `docker-compose.yml`      |
| Add a new slot                | `SLOTS` (scheduler) + `CHECK` constraint (db.js) + `setSlot` (app.js) |
| Add a new column to readings  | `db.js` schema + `POST /api/reading` + CSV header in export route    |

## Patient UI design rules

- Atkinson Hyperlegible font (low-vision optimized) — do not swap
- Minimum 17px body, 19px primary buttons, 26px critical inputs (glucose)
- Tap targets ≥ 44px
- Cream + teal palette only; reds/ambers reserved for range/flag signaling
- No nav menus, no buried settings — everything lives on the one screen
- Modal sheets slide from bottom on mobile, not center dialogs
- One question / focus per screen when entering a reading

## Deployment

Docker on TerraMaster NAS, exposed via Cloudflare Tunnel at `https://health.<domain>`. HTTPS is non-negotiable — PWA install and web push both require it. Do not suggest LAN-only or HTTP-only paths.

iOS push requires iOS 16.4+ **and** Add-to-Home-Screen install. Push will not fire from a Safari tab. Mention this whenever push troubleshooting comes up.

## Out of scope (do not propose)

- HIPAA compliance — use Cloudflare Access or VPN if higher assurance is needed
- Multi-tenant / multi-patient (single-family deployment by design)
- Apple Health / Google Fit sync
- AI / algorithmic dose recommendations (intentionally absent)
- SMS or email reminder channels (PWA push only)

## Operating procedure for changes

1. Read the relevant file(s) before editing.
2. `node --check <file>` after any `.js` edit.
3. If schema changes: current code uses `CREATE TABLE IF NOT EXISTS` — destructive changes require a manual migration. Surface this in your proposal.
4. Test in two roles when route logic changes: patient token and reviewer token.
5. Push notification changes require a service worker version bump (`CACHE = "hl-v1"` → `"hl-v2"` in `sw.js`) so clients re-fetch.

## Operator

Echo-6 (Adam Aguila) — IT consultant, JavaScript-fluent, Salesforce + Power Automate background, runs the NAS that hosts this. Communicate in plain technical terms. He'll deploy, configure Cloudflare Tunnel, and onboard end users (the patient and a second reviewer) himself.
