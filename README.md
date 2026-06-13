# Daily Health Log

Self-hosted PWA for daily diabetic / post-transplant logging. Push notifications, sliding-scale deviation flagging, reviewer dashboard, CSV export.

## What it does

**Patient view** (one URL, bookmarked to home screen):
- Big buttons, large text, Atkinson Hyperlegible (low-vision friendly)
- Daily weight + four glucose checks (breakfast / lunch / dinner / bedtime)
- Bedtime hides insulin and food fields (nighttime basal is separate)
- Push notifications fire on schedule (Pacific Time):
  - **07:00** weight
  - **08:00** breakfast
  - **12:00** lunch
  - **18:00** dinner
  - **20:00** bedtime check
- If not logged: **T+30 min** reminder to patient, **T+60 min** alert to reviewer + marked missed
- Patient never sees the sliding scale

**Reviewer view** (separate URL):
- Overview: 7/14/30/90 day rolling stats, deviation count, missed count
- Readings table with flagged rows highlighted
- Sliding-scale editor (only place it lives)
- CSV export
- Receives push notifications for deviations and missed check-ins

## Stack

- Node 20 + Express + SQLite (better-sqlite3)
- web-push (VAPID) for notifications
- node-cron for scheduling
- Vanilla HTML/CSS/JS frontend (no build step)
- Docker, ~50 MB image

## Deploy on TerraMaster NAS

### 1. Get the code on the NAS

```bash
mkdir -p /volume1/docker/health-log
cd /volume1/docker/health-log
# copy this entire directory in (SMB / SSH / git, whatever you prefer)
```

### 2. Generate VAPID keys (one time)

```bash
cd /volume1/docker/health-log
docker run --rm -v "$PWD:/app" -w /app/server node:20-alpine sh -c \
  "npm install --omit=dev web-push >/dev/null 2>&1 && node ../scripts/generate-keys.js"
```

Copy the output into `.env`:

```bash
cp .env.example .env
nano .env   # paste the three VAPID lines, set PUBLIC_URL
```

### 3. Build and start

```bash
docker compose up -d --build
docker compose logs -f health-log
```

You should see `[server] listening on :3000` and `[scheduler] armed`.

### 4. Expose it on your domain via Cloudflare Tunnel

PWA push **requires HTTPS**. Cloudflare Tunnel is the cleanest path — no NAS ports opened.

```bash
# on the NAS (or wherever cloudflared runs):
cloudflared tunnel create health-log
cloudflared tunnel route dns health-log health.yourdomain.com
```

Add to your tunnel config:
```yaml
ingress:
  - hostname: health.yourdomain.com
    service: http://192.168.0.x:3000     # NAS IP
  - service: http_status:404
```

```bash
cloudflared tunnel run health-log
```

Confirm `https://health.yourdomain.com` loads and shows the auth gate.

### 5. Create users

```bash
# Patient (only one allowed)
docker compose exec health-log node ../scripts/add-user.js patient "Dad" "lawin6969@gmail.com"

# Reviewers (you + one more)
docker compose exec health-log node ../scripts/add-user.js reviewer "Adam" "adamj.aguila@gmail.com"
docker compose exec health-log node ../scripts/add-user.js reviewer "Mike" "mikeaone@gmail.com"

# List anytime
docker compose exec health-log node ../scripts/add-user.js list
```

Each command prints a magic-link URL. Send each user their own link.

### 6. Onboarding the patient

Text/email them the link. On their phone:
1. Open the link in Safari (iOS) or Chrome (Android)
2. Tap Share → **Add to Home Screen**
3. Open it from the home screen icon
4. Tap **Turn on notifications** → Allow

That's it. They now have an app icon, fullscreen UI, and scheduled prompts.

> **iOS note:** Web push only works when the PWA is installed via Add to Home Screen, not in a regular Safari tab. Requires iOS 16.4+.

### 7. Reviewer onboarding

Same flow with the reviewer link. Bookmark or install. Turn on notifications to receive deviation/miss alerts.

### 8. Enter the sliding scale

Open the reviewer view → **Sliding scale** tab. Add the prescribed rows (e.g. 70–149 → 0u, 150–199 → 2u, 200–249 → 4u). The patient never sees this — it only drives deviation flags.

## Backup

The entire database is one file: `./data/health.db`. Snapshot it nightly:

```bash
cd /volume1/docker/health-log
sqlite3 ./data/health.db ".backup './data/health-$(date +%Y%m%d).db'"
```

Or just back up the `data/` directory in your existing NAS backup schedule.

## Reset push for a user

If notifications stop working, the patient can:
1. Open the PWA
2. Tap **Turn on notifications** → **Send test**

If that fails, browser permissions may need resetting in device settings.

## Customizing

- **Schedule times:** edit `SLOTS` in `server/scheduler.js` and restart
- **Glucose target range:** edit `RANGE_LO` / `RANGE_HI` in `public/app.js`
- **Deviation threshold:** in `server/server.js`, change the `Math.abs(ins - expected) >= 0.5` line
- **Time zone:** edit the `TZ` constant in `scheduler.js` and the `TZ` env in compose

## Security model

- One token per user, 24 bytes of randomness, in URL query string the first time
- Token stored in `localStorage` after first visit; URL is rewritten to remove it
- All API calls require the token in `X-Auth` header
- Patient role can't read reviewer endpoints; reviewers can read patient data and edit scale, can't impersonate

**This is not HIPAA-compliant infrastructure.** It's a self-hosted family-care tool. Keep the URLs private, run it behind Cloudflare with Access policies if you want belt-and-suspenders authentication.

## Disclaimer

This is a record-keeping tool, not medical advice. It never recommends doses to the patient — it only stores what was prescribed, what was taken, and flags the difference for human review.
