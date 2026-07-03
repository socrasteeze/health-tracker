# NAS deploy — health-tracker

How this app gets from "code on GitHub" to "running container on the
TerraMaster NAS," triggered by one command from a Windows desktop. This is
the same fetch → build → restart → verify pattern used for other
self-hosted apps on this NAS — see that pattern's generic writeup for the
full rationale. This doc only covers what's specific to health-tracker.

**This replaces the manual "copy the repo to the NAS" step in
[DEPLOY.md](DEPLOY.md) Phase 2 and the README's deploy section.** Everything
after "code is on the NAS" (VAPID keys, Cloudflare Tunnel, `add-user.js`,
onboarding) is unchanged — this only automates getting the code there and
rebuilding.

## This app's values

| Variable | Value | What it is |
|---|---|---|
| `REPO` | `socrasteeze/health-tracker` | GitHub `owner/repo` |
| `BRANCH` | `main` | branch to deploy |
| `APP_DIR` | `/Volume1/health-log` | where the code lands on the NAS |
| `DEFAULT_PORT` | `3000` | host port tried first; auto-rotates up if taken (see below) |
| `TOKEN_FILE` | `$HOME/.cull-token` | shared GitHub PAT, reused across apps |
| Persistent, never overwritten | `.env`, `data/` | VAPID keys + the patient's SQLite DB |

Data and config live at `/Volume1/health-log/data/health.db` and
`/Volume1/health-log/.env` — both are bind-mounted by `docker-compose.yml`,
which already handles env vars and the volume, so the update script calls
`docker compose up -d --build` rather than raw `docker run`.

## Why `.env` and `data/` need explicit protection

The generic pattern's sync step is `rsync -a --delete`, which deletes
anything in `APP_DIR` that isn't in the freshly-fetched tarball. Neither
`.env` (VAPID keys) nor `data/` (the patient's entire logging history) is
committed to git — so an unmodified copy of that script **would silently
delete the database and secrets on every deploy.** [nas-update.sh](nas-update.sh)
excludes both explicitly (and preserves them in the no-`rsync` fallback
path too). If you ever copy this script to a different app, check whether
that app has an equivalent "lives on the NAS, not in git" directory before
reusing it as-is.

## Port auto-rotation

`docker-compose.yml`'s port mapping is `"${HOST_PORT:-3000}:3000"` — the
container always listens on `3000` internally, but the *published* host port
is a variable. `nas-update.sh` tries `3000` first; if `docker compose up`
fails with a port-already-allocated error (something else on the NAS already
bound it), it retries on `3001`, `3002`, ... up to 10 times before giving up.
The port it actually lands on is written to `/Volume1/health-log/.host-port`
and printed at the end of the run.

**This only protects against the container failing to start — it does not
know about your Cloudflare Tunnel config.** If rotation ever actually
triggers, the script prints a loud warning, but the tunnel's ingress rule
(`service: http://<NAS-IP>:3000`) will still point at the old port and the
app will be unreachable from `https://health.<domain>` until you update it
to match. Treat any rotation as a signal to go find out what's squatting on
3000, not just a solved problem.

## One-time setup

Same as any other app on this NAS:

1. **GitHub token** — a `repo`-scoped PAT saved at `~/.cull-token` on the
   NAS (`chmod 600`), shared across apps. Skip if already set up for
   another app.
2. **SSH key auth** from the Windows desktop to `lucyford@EAGLE-424`, so
   [nas-refresh.bat](nas-refresh.bat) doesn't prompt for a password. Skip if
   already set up.
3. **Seed `.env` once, by hand, before the first run** — the update script
   will auto-copy `.env.example` → `.env` if missing, but the placeholder
   values won't have real VAPID keys or `PUBLIC_URL`. Generate keys with
   `node scripts/generate-keys.js` and fill in `.env` on the NAS directly
   (see [DEPLOY.md](DEPLOY.md) Phase 2) before the app is usable.

## Day-to-day update

From the Windows desktop:

```
nas-refresh.bat
```

Or directly on the NAS:

```sh
sh nas-update.sh
```

Either way it: fetches the `main` tarball, syncs it into `/Volume1/health-log`
(preserving `.env` and `data/`), runs `docker compose up -d --build`, then
polls `GET /api/health` until the container answers (or fails loudly after
30s if it doesn't).

## First deploy on a fresh box

`nas-update.sh` assumes `/Volume1/health-log` already exists or can be
created by the NAS user running it, and that `docker compose` is available.
For the very first deploy, run `sh nas-update.sh` directly on the NAS (not
through the `.bat`) so you see any path or permission errors immediately,
then follow [DEPLOY.md](DEPLOY.md) from Phase 2 onward (VAPID keys,
Cloudflare Tunnel, user creation).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Health check fails after 30s | `docker compose logs -f health-log` — usually a missing/blank `.env` |
| `.env` got reset to placeholder values | Confirm `nas-update.sh`'s rsync line still has `--exclude=.env` |
| Container starts but `data/health.db` is empty on a re-deploy | Confirm `--exclude=data` is present — should never trigger, but this is the failure mode if it's ever removed |
| `nas-update.sh` dies with a syntax error mid-run | The self-overwrite re-exec guard at the top is missing or was edited out |
| Deployed on a port other than 3000 | Check `/Volume1/health-log/.host-port`, then update the Cloudflare Tunnel ingress rule to match |

## Next steps

This pipeline itself is done and pushed, but nothing has actually run on the
NAS yet — none of this is exercised until the first live deploy. In order:

- [ ] **Create the GitHub PAT and drop it on the NAS**, if `~/.cull-token`
      doesn't already exist there from another app: GitHub → Settings →
      Developer settings → Personal access tokens → classic token, `repo`
      scope → `echo "ghp_xxx" > ~/.cull-token && chmod 600 ~/.cull-token` on
      the NAS. Without this, `nas-update.sh` exits immediately with "Token
      file not found."
- [ ] **Set up SSH key auth** from the Windows desktop to
      `lucyford@EAGLE-424` (or confirm it's already in place from the cull
      setup) so `nas-refresh.bat` doesn't stop to prompt for a password.
- [ ] **Run `sh nas-update.sh` directly on the NAS once**, not through the
      `.bat`, so a first-run path/permission problem surfaces with output
      you can read immediately instead of over SSH.
- [ ] **Seed real `.env` on the NAS** with actual VAPID keys (`node
      scripts/generate-keys.js`) and the real `PUBLIC_URL` — the script only
      seeds the placeholder `.env.example` if `.env` is missing.
- [ ] **Confirm `/Volume1/health-log/.host-port` reads `3000`** after the
      first successful run, i.e. nothing else on the NAS is squatting on it.
- [ ] Then resume [DEPLOY.md](DEPLOY.md) from **Phase 3** (Cloudflare
      Tunnel) onward — sliding scale intake, tunnel routing, user creation,
      onboarding are all still manual and unaffected by this change.
