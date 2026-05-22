#!/usr/bin/env bash
#
# deploy.sh — cross-build the hamster-cam app image on the dev machine,
# ship it to the Mac Mini, and bring up the Docker Compose stack.
#
# The app runs as a Docker container (hamster-cam/app:local) — it is
# cross-built for linux/amd64 here on the arm64 dev machine and loaded
# onto the host via docker save | gzip | ssh | docker load. The host
# does NOT build anything and does NOT need pnpm or Node installed.
#
# Idempotent: re-run as often as you like.
#
# Configuration (env vars; can be set in a local .env at repo root or
# overridden inline):
#   MAC_MINI_HOST   — hostname or IP of the Mac Mini (default: from .env)
#   MAC_MINI_USER   — SSH user                       (default: from .env)
#   MAC_MINI_PATH   — remote install root            (default: /opt/hamster-cam)
#   SSH_OPTS        — extra ssh / rsync -e options   (optional)
#
# Flags:
#   --sync-env, -e        — also push the dev machine's .env to the Mac Mini
#                           (the remote file is backed up to .env.bak-<ts> first).
#                           OFF by default — the remote .env is normally
#                           authoritative and untouched.
#   --sync-frigate-config — also push mac-mini/frigate-config.yml to the Mini.
#                           (the remote file is backed up to
#                           frigate-config.yml.bak-<ts> first).
#                           OFF by default — the remote copy is host-authoritative:
#                           Frigate's zone editor writes zone coordinates back into
#                           it, and it holds the host-specific WebRTC LAN IP.
#   --infra-only          — skip the image build+ship step; only sync infra
#                           configs and run compose up. Useful when only
#                           Caddyfile / frigate config / mosquitto config changed.
#
# Examples:
#   ./deploy.sh
#   ./deploy.sh --sync-env
#   ./deploy.sh --sync-frigate-config
#   ./deploy.sh --infra-only
#   MAC_MINI_HOST=192.168.1.50 ./deploy.sh
#   SSH_OPTS="-i ~/.ssh/hamster_ed25519" ./deploy.sh
#
# Cutover note (first container deploy):
#   On the Mac Mini, before the first container-based deploy, disable the
#   old systemd service (it conflicts with the container on port 3000):
#     sudo systemctl disable --now hamster-app
#   The service file at app/server/hamster-app.service is kept in the repo
#   as a rollback option. See docs/SETUP_MAC_MINI.md for details.

set -euo pipefail

# ----------------------------------------------------------------------
# CLI flags
# ----------------------------------------------------------------------
SYNC_ENV=0
SYNC_FRIGATE_CONFIG=0
INFRA_ONLY=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --sync-env|-e)
            SYNC_ENV=1
            shift
            ;;
        --sync-frigate-config)
            SYNC_FRIGATE_CONFIG=1
            shift
            ;;
        --infra-only)
            INFRA_ONLY=1
            shift
            ;;
        --help|-h)
            # Print the leading comment block (line 2 → first non-comment line).
            awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
            exit 0
            ;;
        *)
            echo "deploy.sh: unknown argument: $1" >&2
            echo "  try: $0 --help" >&2
            exit 2
            ;;
    esac
done

# Resolve repo root so the script can be invoked from anywhere.
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
REPO_ROOT="$SCRIPT_DIR"
cd "$REPO_ROOT"

# Source .env if it's there — but never require it. Inline overrides win.
if [[ -f .env ]]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
fi

MAC_MINI_HOST=${MAC_MINI_HOST:-}
MAC_MINI_USER=${MAC_MINI_USER:-}
MAC_MINI_PATH=${MAC_MINI_PATH:-/opt/hamster-cam}
SSH_OPTS=${SSH_OPTS:-}
APP_IMAGE="hamster-cam/app:local"

if [[ -z "$MAC_MINI_HOST" || -z "$MAC_MINI_USER" ]]; then
    cat >&2 <<EOF
deploy.sh: MAC_MINI_HOST and MAC_MINI_USER must be set.
Either populate them in .env at the repo root or pass them inline:
  MAC_MINI_HOST=hamster-mac.local MAC_MINI_USER=omegaprime ./deploy.sh
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
# Same as rsync_cmd but WITHOUT --delete. Use when the destination tree is
# SHARED with files this script does not manage.
rsync_nodelete() {
    # shellcheck disable=SC2086
    rsync -az --human-readable -e "ssh $SSH_OPTS" "$@"
}

# ----------------------------------------------------------------------
# 1. (Optional) Cross-build the app image for linux/amd64 and ship it.
#    Skipped when --infra-only is passed.
# ----------------------------------------------------------------------
if [[ "$INFRA_ONLY" == "0" ]]; then
    # Verify buildx is available. The cross-build is mandatory because the
    # dev machine is arm64 and the host is x86_64/amd64 — a native build
    # would produce an arm64 binary that dies on the Mini with "exec format
    # error". The emulated amd64 build (QEMU via Docker Desktop) takes longer
    # (~5-15 min) but produces the correct binary. Run it once per code change.
    if ! docker buildx version > /dev/null 2>&1; then
        cat >&2 <<EOF
deploy.sh: docker buildx is required for the cross-build but is not available.
Install Docker Desktop (includes buildx) or docker-ce with the buildx plugin.
EOF
        exit 1
    fi

    log "cross-building ${APP_IMAGE} for linux/amd64 (arm64→amd64 via QEMU — this takes a few minutes)"
    docker buildx build \
        --platform linux/amd64 \
        -t "${APP_IMAGE}" \
        -f app/Dockerfile \
        --load \
        .

    log "shipping image to ${REMOTE} (docker save | gzip | ssh | docker load)"
    # Pipeline: save → gzip (cuts transfer size ~50-60%) → load on remote.
    # `set -o pipefail` is active so any failure in the pipeline exits non-zero.
    docker save "${APP_IMAGE}" | gzip | ssh_cmd 'gunzip | docker load'

    log "image shipped: ${APP_IMAGE}"
fi

# ----------------------------------------------------------------------
# 2. Pre-flight: ensure remote directories exist.
# ----------------------------------------------------------------------
log "preparing remote layout under ${MAC_MINI_PATH}"
ssh_cmd "mkdir -p \
    '${MAC_MINI_PATH}/db' \
    '${MAC_MINI_PATH}/storage/timelapse' \
    '${MAC_MINI_PATH}/caddy' \
    '${MAC_MINI_PATH}/fail2ban' \
    '${MAC_MINI_PATH}/mosquitto/config' \
    '${MAC_MINI_PATH}/storage/frigate' \
    '${MAC_MINI_PATH}/pi-zero-staging'"

# ----------------------------------------------------------------------
# 3. Sync Mac-Mini-side infra configs (Caddyfile, compose, mosquitto,
#    fail2ban). The remote .env is preserved — we never rsync the dev
#    machine's .env over the Mini's populated one unless --sync-env.
# ----------------------------------------------------------------------
log "syncing Mac Mini infra configs"
# mosquitto/config/passwd is generated on the host (SETUP step 7.1) and is
# NOT in the repo, so without this exclude --delete would wipe it every
# deploy and break broker auth stack-wide.
rsync_nodelete \
    --exclude='.env' \
    --exclude='frigate-config.yml' \
    --exclude='storage/' \
    --exclude='caddy/data/' \
    --exclude='caddy/config/' \
    --exclude='mosquitto/config/passwd' \
    mac-mini/ "${REMOTE}:${MAC_MINI_PATH}/"
# frigate-config.yml is excluded above because it is host-authoritative:
# Frigate's zone editor writes zone coordinates back into the Mini's copy,
# and it holds the host-specific WebRTC candidate LAN IP.

# ----------------------------------------------------------------------
# 3b. Optional: push the dev machine's .env to the Mac Mini.
# ----------------------------------------------------------------------
if [[ "$SYNC_ENV" == "1" ]]; then
    if [[ ! -f .env ]]; then
        echo "deploy.sh: --sync-env passed but no .env at repo root." >&2
        echo "deploy.sh: copy .env.example to .env and populate it first." >&2
        exit 2
    fi
    BACKUP_NAME=".env.bak-$(date -u +%Y%m%dT%H%M%SZ)"
    log "syncing local .env → ${MAC_MINI_PATH}/.env (remote backed up to ${BACKUP_NAME})"
    ssh_cmd "if [[ -f '${MAC_MINI_PATH}/.env' ]]; then cp -p '${MAC_MINI_PATH}/.env' '${MAC_MINI_PATH}/${BACKUP_NAME}'; fi"
    rsync_cmd --chmod=F600 .env "${REMOTE}:${MAC_MINI_PATH}/.env"
fi

# ----------------------------------------------------------------------
# 3c. Optional: push the repo's mac-mini/frigate-config.yml to the Mini.
# ----------------------------------------------------------------------
if [[ "$SYNC_FRIGATE_CONFIG" == "1" ]]; then
    FRIGATE_CFG="mac-mini/frigate-config.yml"
    if [[ ! -f "$FRIGATE_CFG" ]]; then
        echo "deploy.sh: --sync-frigate-config passed but ${FRIGATE_CFG} not found." >&2
        exit 2
    fi
    BACKUP_NAME="frigate-config.yml.bak-$(date -u +%Y%m%dT%H%M%SZ)"
    log "syncing ${FRIGATE_CFG} → ${MAC_MINI_PATH}/frigate-config.yml (remote backed up to ${BACKUP_NAME})"
    ssh_cmd "if [[ -f '${MAC_MINI_PATH}/frigate-config.yml' ]]; then cp -p '${MAC_MINI_PATH}/frigate-config.yml' '${MAC_MINI_PATH}/${BACKUP_NAME}'; fi"
    rsync_cmd "$FRIGATE_CFG" "${REMOTE}:${MAC_MINI_PATH}/frigate-config.yml"
fi

# ----------------------------------------------------------------------
# 4. Stage Pi-Zero artifacts on the Mac Mini for the operator to scp
#    onward to each Pi (per docs/SETUP_PI_ZERO.md). Deliberately a
#    separate manual step — we don't want a misconfigured deploy.sh
#    rebooting three Pi Zeros at once.
# ----------------------------------------------------------------------
log "staging pi-zero/ artifacts (not pushed to Pis automatically)"
rsync_cmd pi-zero/ "${REMOTE}:${MAC_MINI_PATH}/pi-zero-staging/"

# ----------------------------------------------------------------------
# 5. Bring up the hamster-app container (and any other changed services).
#    `docker compose up -d` is idempotent and will only recreate services
#    whose image or config changed. The new image load in step 1 changes
#    the image digest, which triggers hamster-app recreation automatically.
#    No sudo needed — omegaprime is in the docker group.
# ----------------------------------------------------------------------
log "remote: docker compose up"
ssh_cmd "bash -se" <<EOREMOTE
set -euo pipefail
cd '${MAC_MINI_PATH}'

# Rebuild the Caddy image if its Dockerfile or plugins changed (build context
# is local on the Mini). Skip if the image already exists and nothing changed
# (docker compose build is a no-op when the context hash is unchanged).
docker compose --env-file .env build caddy

# Recreate only the hamster-app container so it picks up the new image.
# Other services (mosquitto, frigate, caddy, cloudflare-ddns) are left
# running unless their own definition changed.
docker compose --env-file .env up -d --remove-orphans hamster-app

# Bring everything else up (no-op if already running and unchanged).
docker compose --env-file .env up -d --remove-orphans
EOREMOTE

log "done. Tail logs with:"
log "  ssh ${REMOTE} 'cd ${MAC_MINI_PATH} && docker compose logs -f hamster-app'"
