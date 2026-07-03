#!/bin/sh
# Fetches the latest health-tracker code from GitHub, rebuilds, and restarts
# the container on the NAS. Run directly on the NAS (`sh nas-update.sh`) or
# remotely via nas-refresh.bat. See NAS_DEPLOY.md for the full writeup.
set -eu

# --- edit these to match your setup ---
REPO="socrasteeze/health-tracker"
BRANCH="main"
APP_DIR="/Volume1/health-log"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.cull-token}"
PORT=3000
# ---------------------------------------

# Re-exec from a throwaway copy so rsync overwriting this file mid-run can't
# crash the interpreter reading it.
if [ -z "${CULL_UPDATER_REEXEC:-}" ]; then
  _self_copy="$(mktemp)"
  cp "$0" "$_self_copy"
  CULL_UPDATER_REEXEC=1 exec sh "$_self_copy" "$@"
fi

if [ ! -f "$TOKEN_FILE" ]; then
  echo "Token file not found: $TOKEN_FILE" >&2
  exit 1
fi
TOKEN="$(cat "$TOKEN_FILE")"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Fetching $REPO@$BRANCH"
DL="https://api.github.com/repos/$REPO/tarball/$BRANCH"
if command -v curl >/dev/null 2>&1; then
  curl -fSL -H "Authorization: Bearer $TOKEN" "$DL" -o "$TMP/app.tar.gz"
else
  wget --header="Authorization: Bearer $TOKEN" -O "$TMP/app.tar.gz" "$DL"
fi

mkdir -p "$TMP/src"
tar -xzf "$TMP/app.tar.gz" -C "$TMP/src" --strip-components=1

mkdir -p "$APP_DIR" "$APP_DIR/data"

echo "==> Syncing into $APP_DIR"
# --exclude=.env and --exclude=data are load-bearing: .env holds the VAPID
# keys and data/health.db is the patient's entire database. Neither is in
# the git tarball, so a plain rsync --delete would erase both on every run.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude=.env --exclude=data "$TMP/src"/ "$APP_DIR"/
else
  # No rsync: stash the two things that must survive, wipe, copy, restore.
  [ -f "$APP_DIR/.env" ] && cp "$APP_DIR/.env" "$TMP/.env.bak" || true
  find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name data ! -name .env -exec rm -rf {} +
  cp -a "$TMP/src"/. "$APP_DIR"/
  [ -f "$TMP/.env.bak" ] && cp "$TMP/.env.bak" "$APP_DIR/.env" || true
fi

if [ ! -f "$APP_DIR/.env" ]; then
  echo "==> No .env found — seeding from .env.example (edit before this is usable)"
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
fi

echo "==> Building and restarting"
cd "$APP_DIR"
docker compose up -d --build

echo "==> Waiting for health check"
i=0
until curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 15 ]; then
    echo "Health check failed after 30s — check: docker compose logs -f health-log" >&2
    exit 1
  fi
  sleep 2
done

echo "==> Up: $(curl -fsS "http://localhost:$PORT/api/health")"
