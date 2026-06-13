# DEPLOY.md — Operational Checklist

Working file. Check items as completed. Each task is a discrete step CC can execute or verify.

---

## Phase 0 — Intel gathering (before any code moves)

- [ ] **Sliding scale obtained** — exact ranges + units from patient's doctor or transplant team. Format: `from_glucose, to_glucose, units` per row.
- [ ] **FQDN decided** — e.g. `health.example.com`. Confirm DNS is on Cloudflare.
- [ ] **Patient device verified** — iOS 16.4+ or Android Chrome. Older iOS = no push, downgrade plan needed.
- [ ] **Second reviewer identified** — name + email/phone for the family member.
- [ ] **In-person onboarding window scheduled** — 15 min with patient, their phone in hand.

---

## Phase 1 — Local prep

- [ ] Repo unzipped to working location on dev machine.
- [ ] `CLAUDE.md` confirmed present at repo root.
- [ ] `.env.example` reviewed.
- [ ] Patient name + reviewer names finalized for `add-user.js` commands.

---

## Phase 2 — NAS deploy

- [ ] Repo copied to NAS: `/volume1/docker/health-log/`
- [ ] `cd /volume1/docker/health-log`
- [ ] **Generate VAPID keys:**
  ```bash
  docker run --rm -v "$PWD:/app" -w /app/server node:20-alpine sh -c \
    "npm install --omit=dev web-push >/dev/null 2>&1 && node ../scripts/generate-keys.js"
  ```
- [ ] `.env` created from `.env.example`, populated with:
  - [ ] `VAPID_PUBLIC`
  - [ ] `VAPID_PRIVATE`
  - [ ] `VAPID_SUBJECT=mailto:<your email>`
  - [ ] `PUBLIC_URL=https://health.<domain>`
- [ ] **Build + start:**
  ```bash
  docker compose up -d --build
  ```
- [ ] Logs show `[server] listening on :3000` and `[scheduler] armed`:
  ```bash
  docker compose logs -f health-log
  ```
- [ ] Health check from NAS shell: `curl http://localhost:3000/api/health` returns `{"ok":true,...}`

---

## Phase 3 — Cloudflare Tunnel

- [ ] `cloudflared` installed (NAS, separate Pi, or wherever).
- [ ] **Create tunnel:**
  ```bash
  cloudflared tunnel create health-log
  ```
- [ ] **Route DNS:**
  ```bash
  cloudflared tunnel route dns health-log health.<domain>
  ```
- [ ] Ingress config updated:
  ```yaml
  ingress:
    - hostname: health.<domain>
      service: http://<NAS-IP>:3000
    - service: http_status:404
  ```
- [ ] **Run tunnel:**
  ```bash
  cloudflared tunnel run health-log
  ```
  (or `systemctl enable --now cloudflared` if installed as service)
- [ ] `https://health.<domain>` loads from external network → shows auth gate.
- [ ] HTTPS lock icon confirmed (PWA install + push depend on it).

---

## Phase 4 — Operator account + stack validation

> Validate the full stack on **your own** device before handing the patient anything.

- [ ] **Create reviewer (yourself):**
  ```bash
  docker compose exec health-log node ../scripts/add-user.js reviewer "Adam Aguila" "you@email.com"
  ```
- [ ] Magic link copied from CLI output.
- [ ] Reviewer link opened on your phone → dashboard loads.
- [ ] PWA installed: Share → Add to Home Screen → opened from home screen icon.
- [ ] Push enabled: tap "Turn on reviewer notifications" → Allow.
- [ ] Test push fires successfully.
- [ ] Sliding scale entered on Scale tab → Save → page reload retains rows.

---

## Phase 5 — Patient + second reviewer

- [ ] **Create patient:**
  ```bash
  docker compose exec health-log node ../scripts/add-user.js patient "<Name>" "<email>"
  ```
- [ ] **Create second reviewer:**
  ```bash
  docker compose exec health-log node ../scripts/add-user.js reviewer "<Name>" "<email>"
  ```
- [ ] Magic links saved securely (1Password / Bitwarden / signal-to-self).
- [ ] List confirms three users total:
  ```bash
  docker compose exec health-log node ../scripts/add-user.js list
  ```

---

## Phase 6 — Patient onboarding (in person)

- [ ] Magic link delivered to patient's phone (text/email).
- [ ] Patient opens link in Safari (iOS) or Chrome (Android).
- [ ] Share → Add to Home Screen.
- [ ] App opened from home screen icon (not browser tab).
- [ ] "Turn on notifications" → Allow.
- [ ] Practice entry walkthrough:
  - [ ] Patient logs current weight.
  - [ ] Patient logs a glucose reading with food and insulin.
  - [ ] Confirm both appear on screen after save.

---

## Phase 7 — End-to-end smoke test

- [ ] On reviewer device: refresh dashboard → patient's practice entries visible.
- [ ] On reviewer device: hit `/api/push/test` → confirm patient device receives notification.
- [ ] **Deviation test:** patient enters glucose value with insulin that doesn't match the sliding scale → reviewer receives "Insulin deviation" push within seconds → row appears flagged in dashboard.
- [ ] **Schedule test:** verify next scheduled prompt fires at correct PT time on patient device.
- [ ] CSV export from reviewer dashboard downloads and opens cleanly in Excel.

---

## Phase 8 — Hardening

- [ ] Backup cron configured:
  ```bash
  # add to NAS crontab
  0 2 * * * sqlite3 /volume1/docker/health-log/data/health.db ".backup '/volume1/backups/health-$(date +\%Y\%m\%d).db'"
  ```
- [ ] Old backups rotation: keep last 30 days, delete older.
- [ ] (Optional) Cloudflare Access policy added to `health.<domain>` with email allowlist for belt-and-suspenders auth.
- [ ] Magic links archived in password manager — recovery if a user clears their browser storage.
- [ ] Reviewer dashboard URL added to your phone's home screen.

---

## Phase 9 — Handoff

- [ ] Patient knows:
  - [ ] To tap the home screen icon, not Safari
  - [ ] What each prompt asks for
  - [ ] That reviewers see their data
  - [ ] That you're available if something breaks
- [ ] Second reviewer briefed on dashboard, scale tab, CSV export.
- [ ] Doctor's office knows where to request data from (you export CSV on request).

---

## Quick reference — common ops

| Need to… | Command |
|---|---|
| See container logs | `docker compose logs -f health-log` |
| Restart | `docker compose restart health-log` |
| Pull updates + rebuild | `docker compose up -d --build` |
| List users | `docker compose exec health-log node ../scripts/add-user.js list` |
| Add reviewer | `docker compose exec health-log node ../scripts/add-user.js reviewer "Name" "email"` |
| Delete user | `docker compose exec health-log node ../scripts/add-user.js delete <id>` |
| Manual SQL | `docker compose exec health-log sqlite3 /data/health.db` |
| Backup now | `docker compose exec health-log sqlite3 /data/health.db ".backup '/data/snap-$(date +%F).db'"` |

---

## Known gaps — backlog

- [ ] Patient-side edit/delete on past readings
- [ ] Patient-side view of yesterday/last 7 days
- [ ] Reviewer-side edit/delete on readings
- [ ] Bilingual support if needed
- [ ] Medication adherence tracking (immunosuppressants)
- [ ] Automated backup rotation script
- [ ] Healthcheck endpoint hooked to Uptime Kuma or similar

---

## Status flags

- 🟢 **Live** — patient logging daily, alerts working
- 🟡 **Deployed, awaiting patient onboarding**
- 🔴 **Not deployed**

**Current status:** 🔴
