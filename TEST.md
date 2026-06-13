# TEST.md — Local Test Runbook

Validate the full stack on your desktop before deploying to the NAS. Catches misconfigs cheap.

---

## Two paths — pick one

| Path | Setup time | Iteration speed | Matches prod |
|---|---|---|---|
| **Docker Desktop** *(recommended)* | 5 min | Medium | Exact |
| **Plain Node** | 2 min | Fast | Close (no Alpine) |

If Docker Desktop is already running on your rig, use Docker. Otherwise plain Node is fine for UI work.

---

## Path A — Docker Desktop

### A1. Build + start

From the repo root (e.g. `C:\dev\health-log` or wherever you unzipped):

```bash
# Generate VAPID keys (one-time)
docker run --rm -v "${PWD}:/app" -w /app/server node:20-alpine sh -c \
  "npm install --omit=dev web-push >/dev/null 2>&1 && node ../scripts/generate-keys.js"
```

Copy the three lines into a new `.env` file:

```bash
cp .env.example .env
# edit .env with the keys + set:
# PUBLIC_URL=http://localhost:3000
```

Start:

```bash
docker compose up --build
```

Leave logs streaming in that terminal. You should see:
```
[server] listening on :3000
[scheduler] armed · TZ=America/Los_Angeles · slots=weight,breakfast,lunch,dinner,bedtime
```

### A2. Create test users

In a second terminal:

```bash
docker compose exec health-log node ../scripts/add-user.js patient   "Test Patient"  "patient@test.local"
docker compose exec health-log node ../scripts/add-user.js reviewer  "Test Reviewer" "reviewer@test.local"
docker compose exec health-log node ../scripts/add-user.js list
```

Copy both magic links.

---

## Path B — Plain Node (no Docker)

### B1. Prereqs

- Node 20+ installed
- On Windows: Visual Studio Build Tools for `better-sqlite3` native compile (`npm install --global windows-build-tools` legacy, or install "Desktop development with C++" workload via Visual Studio Installer)
- On Mac/Linux: nothing extra

### B2. Install + run

```bash
cd server
npm install
cd ..

# Generate keys
node scripts/generate-keys.js
```

Create `.env` in repo root with the keys + `PUBLIC_URL=http://localhost:3000`.

Set env vars and start (Linux/Mac):
```bash
export $(cat .env | xargs)
export DB_PATH=./data/health.db
mkdir -p data
cd server && node server.js
```

Windows PowerShell:
```powershell
Get-Content ../.env | ForEach-Object { $k,$v=$_.split('=',2); Set-Item "env:$k" $v }
$env:DB_PATH="./data/health.db"
mkdir ../data -Force
node server.js
```

### B3. Create users (in a second terminal)

```bash
node scripts/add-user.js patient   "Test Patient"  "patient@test.local"
node scripts/add-user.js reviewer  "Test Reviewer" "reviewer@test.local"
node scripts/add-user.js list
```

---

## Test flows — desktop only

> Localhost is treated as secure context by Chrome and Edge, so service worker + push notifications work without HTTPS. Safari and Firefox have stricter rules — use Chrome on desktop for the cleanest test.

### T1. Patient flow
- [ ] Open patient magic link in Chrome (incognito recommended — clean state)
- [ ] Auth gate disappears, "Hi Test Patient." renders
- [ ] Log today's weight → appears in card
- [ ] Tap "+ Add a blood sugar reading" → modal opens
- [ ] Select Breakfast, enter 145, 2 units, "oatmeal" → save
- [ ] Reading appears with green "In range" dot
- [ ] Enter a Bedtime reading → confirm no insulin/food fields shown

### T2. Reviewer flow
- [ ] Open reviewer magic link in a second Chrome window (or different profile)
- [ ] Patient's entries appear on Overview
- [ ] Stats card shows averages + counts
- [ ] Readings tab shows the full table
- [ ] Scale tab: enter test rows e.g. `70–149 → 0`, `150–199 → 2`, `200–249 → 4` → Save

### T3. Deviation flag
- [ ] Patient: log a reading at glucose 220 with 0u insulin (scale says 4u)
- [ ] Reviewer dashboard auto-refresh / manual refresh → row shows red "DEV" pill
- [ ] Overview deviations counter increments
- [ ] CSV export shows `Flagged: YES` for that row

### T4. CSV export
- [ ] Reviewer → "Export CSV" → file downloads
- [ ] Opens in Excel with all columns, weights inline with first reading of each day

### T5. Push notifications (desktop Chrome)
- [ ] Patient view: tap "Turn on notifications" → Chrome permission prompt → Allow
- [ ] Button changes to "Send test notification" → tap it
- [ ] System notification fires
- [ ] Repeat for reviewer view in second window

---

## Test flows — phone (without deploying)

Push on iOS needs HTTPS + PWA install. Cloudflare's quick tunnel gives you a temporary public HTTPS URL in 30 seconds.

### T6. Spin up quick tunnel

In a third terminal:

```bash
# Install cloudflared if you don't have it
# Windows: winget install cloudflare.cloudflared
# Mac:     brew install cloudflared

cloudflared tunnel --url http://localhost:3000
```

You'll get a URL like `https://random-words-1234.trycloudflare.com`. Copy it.

### T7. Update PUBLIC_URL + recreate users

The magic links you generated point at `localhost`. Either:

**Option A — quick:** manually rewrite the path. If the original link was `http://localhost:3000/?t=abc123`, just hit `https://random-words-1234.trycloudflare.com/?t=abc123` on your phone.

**Option B — clean:** stop the container, update `.env` `PUBLIC_URL` to the tunnel URL, restart, regenerate the magic links so the CLI output prints the correct base.

### T8. Phone test
- [ ] Open the tunnel URL on patient phone in Safari (iOS) or Chrome (Android)
- [ ] Share → Add to Home Screen
- [ ] Open from home screen icon
- [ ] Turn on notifications → Allow
- [ ] Send test push from desktop reviewer dashboard's test button → patient phone buzzes
- [ ] Log a deviation reading on patient phone → reviewer phone receives push

### T9. Tear down test tunnel
- [ ] Ctrl+C the cloudflared process. URL dies. No cleanup needed.

---

## Testing the schedule + miss flow (fast)

Default schedule fires at 0700/0800/1200/1800/2000 PT — useless for live testing. Two options:

### Option 1 — Manual API trigger

The server doesn't expose a "fire now" endpoint by default. You can validate the *prompt* push by hitting `/api/push/test` from a logged-in session, which proves the push pipe works.

### Option 2 — Temporary fast schedule

Edit `server/scheduler.js`, replace the `SLOTS` block with:

```js
const SLOTS = {
  breakfast: { hour: <current PT hour>, min: <current PT min + 1>, title: "Breakfast check", body: "Test prompt." },
};
```

Restart. Wait 1 minute for prompt, 31 min for reminder, 61 min for reviewer miss alert. **Revert before deploying to NAS.**

---

## Test database — reset between runs

If you want a clean slate:

```bash
# Docker
docker compose down
rm -rf data/
docker compose up --build

# Plain Node — stop server first
rm -rf data/
node server.js
```

Then re-run the `add-user.js` commands.

---

## Common local issues

| Symptom | Fix |
|---|---|
| `better-sqlite3` install fails on Windows | Install C++ Build Tools or use Docker path |
| Service worker not registering | Must use `http://localhost:...`, not `127.0.0.1` |
| Push permission denied | Reset site permissions in Chrome → Settings → Privacy → Site Settings |
| Notification fires but no sound | Check OS-level notification settings; not a code issue |
| Logs show `VAPID keys not set` | `.env` not loaded — verify file exists, restart container |
| Quick tunnel URL changes every restart | Expected — `cloudflared tunnel --url` is ephemeral. Use named tunnel for stable URL. |

---

## Exit criteria — green to deploy to NAS

All boxes checked:

- [ ] T1 — Patient flow works end-to-end
- [ ] T2 — Reviewer flow works
- [ ] T3 — Deviation flag fires
- [ ] T4 — CSV export valid
- [ ] T5 — Desktop push works
- [ ] T8 — Phone push works via quick tunnel
- [ ] Logs clean — no errors, no `VAPID keys not set` warnings

Once green, follow DEPLOY.md from Phase 2.
