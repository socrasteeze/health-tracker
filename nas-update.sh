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
DEFAULT_PORT=3000
MAX_PORT_TRIES=10
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

# Try DEFAULT_PORT first; if something else on the NAS already holds it,
# bump to the next one instead of failing the whole deploy. HOST_PORT flows
# into docker-compose.yml's "${HOST_PORT:-3000}:3000" mapping — the
# container's internal port never changes, only what's published on the host.
port="$DEFAULT_PORT"
try=0
while :; do
  export HOST_PORT="$port"
  compose_out="$(docker compose up -d --build 2>&1)" && break
  if printf '%s\n' "$compose_out" | grep -qiE "port is already allocated|address already in use|bind: "; then
    try=$((try + 1))
    if [ "$try" -ge "$MAX_PORT_TRIES" ]; then
      echo "Gave up after $MAX_PORT_TRIES ports starting at $DEFAULT_PORT — none free." >&2
      printf '%s\n' "$compose_out" >&2
      exit 1
    fi
    echo "==> Port $port busy, trying $((port + 1))"
    port=$((port + 1))
    continue
  fi
  printf '%s\n' "$compose_out" >&2
  exit 1
done
printf '%s\n' "$compose_out"

if [ "$port" != "$DEFAULT_PORT" ]; then
  echo "!! Bound to port $port instead of the default $DEFAULT_PORT." >&2
  echo "!! If Cloudflare Tunnel's ingress config points at :$DEFAULT_PORT, update it to :$port or this deploy is unreachable externally." >&2
fi
echo "$port" > "$APP_DIR/.host-port"

echo "==> Waiting for health check"
i=0
until curl -fsS "http://localhost:$port/api/health" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 15 ]; then
    echo "Health check failed after 30s — check: docker compose logs -f health-log" >&2
    exit 1
  fi
  sleep 2
done

echo "==> Up on port $port: $(curl -fsS "http://localhost:$port/api/health")"
