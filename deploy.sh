#!/usr/bin/env bash
#
# deploy.sh — push a fresh hamster-cam build from the dev machine to the
# Mac Mini and bounce the systemd unit + docker compose stack.
#
# Idempotent: re-run as often as you like. Builds locally, rsyncs only
# what changed, restarts the app, runs `docker compose up -d` to apply
# any infra-config changes. Pi-side artifacts are staged but not pushed
# to individual Pis (see SETUP_PI_ZERO.md for the per-Pi flow).
#
# Configuration (env vars; can be set in a local .env at repo root or
# overridden inline):
#   MAC_MINI_HOST   — hostname or IP of the Mac Mini (default: from .env)
#   MAC_MINI_USER   — SSH user                       (default: from .env)
#   MAC_MINI_PATH   — remote install root            (default: /opt/hamster-cam)
#   SSH_OPTS        — extra ssh / rsync -e options   (optional)
#
# Examples:
#   ./deploy.sh
#   MAC_MINI_HOST=192.168.1.50 ./deploy.sh
#   SSH_OPTS="-i ~/.ssh/hamster_ed25519" ./deploy.sh

set -euo pipefail

# Resolve repo root so the script can be invoked from anywhere.
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
REPO_ROOT="$SCRIPT_DIR"
cd "$REPO_ROOT"

# Source .env if it's there — but never require it. Inline overrides win.
if [[ -f .env ]]; then
    # .env is not version-controlled, so shellcheck can't follow it.
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
fi

MAC_MINI_HOST=${MAC_MINI_HOST:-}
MAC_MINI_USER=${MAC_MINI_USER:-}
MAC_MINI_PATH=${MAC_MINI_PATH:-/opt/hamster-cam}
SSH_OPTS=${SSH_OPTS:-}

if [[ -z "$MAC_MINI_HOST" || -z "$MAC_MINI_USER" ]]; then
    cat >&2 <<EOF
deploy.sh: MAC_MINI_HOST and MAC_MINI_USER must be set.
Either populate them in .env at the repo root or pass them inline:
  MAC_MINI_HOST=hamster-mac.local MAC_MINI_USER=hamster ./deploy.sh
EOF
    exit 2
fi

REMOTE="${MAC_MINI_USER}@${MAC_MINI_HOST}"

log() {
    printf '\033[1;36m==>\033[0m %s\n' "$*"
}

# Wrapper so the same -e flag goes to both rsync and ssh without quoting headaches.
ssh_cmd() {
    # SC2086 — SSH_OPTS is deliberately word-split so callers can pass
    # multi-token options like `-i ~/.ssh/key -o ConnectTimeout=10`.
    # SC2029 — the `$@` is intended to expand on the LOCAL side; that's
    # how we forward an already-quoted command string to the remote shell.
    # shellcheck disable=SC2086,SC2029
    ssh $SSH_OPTS "$REMOTE" "$@"
}
rsync_cmd() {
    # shellcheck disable=SC2086
    rsync -az --delete --human-readable -e "ssh $SSH_OPTS" "$@"
}

# ----------------------------------------------------------------------
# 1. Build locally (web + server). pnpm-rooted workspaces handle deps.
# ----------------------------------------------------------------------
log "building app/server (tsup)"
pnpm -C app/server build

log "building app/web (vite)"
pnpm -C app/web build

# ----------------------------------------------------------------------
# 2. Pre-flight: ensure remote directories exist. Created with mkdir -p
#    so re-runs are no-ops. We do NOT chown — the operator owns
#    /opt/hamster-cam per docs/SETUP_MAC_MINI.md step 4.
# ----------------------------------------------------------------------
log "preparing remote layout under ${MAC_MINI_PATH}"
ssh_cmd "mkdir -p \
    '${MAC_MINI_PATH}/app/server' \
    '${MAC_MINI_PATH}/app/server/migrations' \
    '${MAC_MINI_PATH}/app/web/dist' \
    '${MAC_MINI_PATH}/caddy' \
    '${MAC_MINI_PATH}/fail2ban' \
    '${MAC_MINI_PATH}/mosquitto/config' \
    '${MAC_MINI_PATH}/storage/frigate' \
    '${MAC_MINI_PATH}/db' \
    '${MAC_MINI_PATH}/pi-zero-staging'"

# ----------------------------------------------------------------------
# 3. Sync the backend bundle + package.json + migrations + systemd unit.
#    We deliberately do NOT rsync node_modules from the dev machine —
#    Mac Mini and a dev MacBook may not have the same native-module ABI
#    (better-sqlite3 is the obvious one). We `pnpm install --prod`
#    remote-side once everything else is in place.
# ----------------------------------------------------------------------
log "syncing app/server bundle"
rsync_cmd \
    --exclude='node_modules' \
    --exclude='*.test.*' \
    --exclude='test/' \
    app/server/dist/ "${REMOTE}:${MAC_MINI_PATH}/app/server/dist/"

rsync_cmd app/server/package.json "${REMOTE}:${MAC_MINI_PATH}/app/server/package.json"
rsync_cmd app/server/migrations/ "${REMOTE}:${MAC_MINI_PATH}/app/server/migrations/"
rsync_cmd app/server/hamster-app.service "${REMOTE}:${MAC_MINI_PATH}/app/server/hamster-app.service"

log "syncing pnpm-workspace metadata + lockfile (needed by pnpm install --prod)"
rsync_cmd pnpm-lock.yaml "${REMOTE}:${MAC_MINI_PATH}/pnpm-lock.yaml"
rsync_cmd pnpm-workspace.yaml "${REMOTE}:${MAC_MINI_PATH}/pnpm-workspace.yaml"
rsync_cmd package.json "${REMOTE}:${MAC_MINI_PATH}/package.json"

# ----------------------------------------------------------------------
# 4. Sync the React build. Backend's static handler (or Caddy, if you
#    prefer that path later) serves this. Path is referenced from
#    /opt/hamster-cam/app/web/dist; the backend has a built-in default.
# ----------------------------------------------------------------------
log "syncing app/web/dist"
rsync_cmd app/web/dist/ "${REMOTE}:${MAC_MINI_PATH}/app/web/dist/"

# ----------------------------------------------------------------------
# 5. Sync Mac-Mini-side infra configs. The remote .env is preserved
#    deliberately — we never rsync the dev machine's .env over the
#    Mini's populated one.
# ----------------------------------------------------------------------
log "syncing Mac Mini infra configs"
rsync_cmd \
    --exclude='.env' \
    --exclude='storage/' \
    --exclude='caddy/data/' \
    --exclude='caddy/config/' \
    mac-mini/ "${REMOTE}:${MAC_MINI_PATH}/"

# ----------------------------------------------------------------------
# 6. Stage Pi-Zero artifacts on the Mac Mini for the operator to scp
#    onward to each Pi (per docs/SETUP_PI_ZERO.md). Deliberately a
#    separate manual step — we don't want a misconfigured deploy.sh
#    rebooting three Pi Zeros at once.
# ----------------------------------------------------------------------
log "staging pi-zero/ artifacts (not pushed to Pis automatically)"
rsync_cmd pi-zero/ "${REMOTE}:${MAC_MINI_PATH}/pi-zero-staging/"

# ----------------------------------------------------------------------
# 7. Remote-side: install prod deps, restart the systemd unit, refresh
#    the docker compose stack.
# ----------------------------------------------------------------------
log "remote: pnpm install --prod and service bounce"
# Quoting the heredoc with 'EOREMOTE' means $vars expand on the remote, not here.
# We interpolate the path once via ${MAC_MINI_PATH@Q} (the bash 4.4+ Q operator)
# so it's quoted safely regardless of contents.
ssh_cmd "bash -se" <<EOREMOTE
set -euo pipefail
cd "${MAC_MINI_PATH}"

# Install backend prod deps — rebuilds better-sqlite3 against the local
# Node ABI on first run; subsequent runs are no-ops if the lockfile is
# unchanged.
if command -v pnpm >/dev/null 2>&1; then
    pnpm install --prod --frozen-lockfile --filter @hamster-cam/server...
else
    echo "deploy.sh: pnpm is not installed on the Mac Mini. Install with: npm i -g pnpm" >&2
    exit 1
fi

# Reload systemd in case the unit file changed since last deploy.
if [[ -f /etc/systemd/system/hamster-app.service ]]; then
    if ! sudo -n true 2>/dev/null; then
        echo "deploy.sh: sudo password required for systemctl restart" >&2
    fi
    sudo cp app/server/hamster-app.service /etc/systemd/system/hamster-app.service
    sudo systemctl daemon-reload
    sudo systemctl restart hamster-app
else
    echo "deploy.sh: /etc/systemd/system/hamster-app.service not installed yet."
    echo "deploy.sh: run the one-time install per docs/SETUP_MAC_MINI.md step 10."
fi

# Bring the Docker stack up. Idempotent — running compose up -d on an
# already-running stack just recreates services whose definition changed.
docker compose --env-file .env -f docker-compose.yml up -d --remove-orphans
EOREMOTE

log "done. Tail logs with: ssh ${REMOTE} 'journalctl -fu hamster-app'"
