#!/usr/bin/env bash
# scripts/mask-audit/audit.sh
#
# Diagnose whether Frigate's object masks are throwing away real hamster
# detections — visualised by overlaying the LIVE config's mask polygons on
# top of recent event snapshots and rendering the result as an HTML grid.
#
# Why: a frame inside an object mask is *discarded by Frigate*, not just
# hidden. Over-aggressive masks produce the classic "model recognises then
# loses Remy" symptom (see docs/HAMSTER_MODEL_TUNING.md §0 + §9 + the live
# config's cam1/cam2 mask blocks). This script answers the question
# "are the masks eating real detections?" with pictures, not vibes.
#
# Usage:
#   ./scripts/mask-audit/audit.sh                # last 24h, default host
#   ./scripts/mask-audit/audit.sh 48             # last 48h
#   ./scripts/mask-audit/audit.sh 24 user@host   # custom host
#
# Output:
#   scripts/mask-audit/out/index.html  ← open in a browser
#   scripts/mask-audit/out/live-config.yml
#   scripts/mask-audit/out/{hamster_cam_1,hamster_cam_2}/*.jpg
#
# Requires on dev host : ssh, scp, tar, python3 (stdlib only)
# Requires on remote   : docker (Frigate container running), curl, python3

set -euo pipefail

HOURS="${1:-24}"
HOST="${2:-omegaprime@project-server}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$SCRIPT_DIR/out"

rm -rf "$OUT"
mkdir -p "$OUT/hamster_cam_1" "$OUT/hamster_cam_2"

# Cross-platform "N hours ago" → unix epoch
if date -v-1H +%s >/dev/null 2>&1; then
  SINCE="$(date -v-"${HOURS}"H +%s)"      # BSD date (macOS)
else
  SINCE="$(date -d "-${HOURS} hours" +%s)" # GNU date (Linux)
fi

echo "==> Pulling live config + last ${HOURS}h of events from $HOST"

ssh "$HOST" "SINCE='$SINCE' bash -s" <<'REMOTE'
set -euo pipefail
WORK="/tmp/mask-audit-$$"
mkdir -p "$WORK/hamster_cam_1" "$WORK/hamster_cam_2"

# Live Frigate config — Frigate writes back UI zone/mask edits, so the
# file inside the container is the ground truth, not the repo copy.
if docker exec hamster-frigate cat /config/config.yml > "$WORK/live-config.yml" 2>/dev/null; then
  :
else
  echo "WARN: docker exec failed; falling back to host bind-mount"
  cp /opt/hamster-cam/frigate-config/config.yml "$WORK/live-config.yml" 2>/dev/null \
    || cp /opt/hamster-cam/frigate-config.yml "$WORK/live-config.yml"
fi

# Pull recent events (≤60 per camera, has_snapshot only) and snapshot.jpg
# for each. bbox=1 draws the saved detection box; crop=0 keeps the full
# frame so the mask coords overlay cleanly. Filenames are sortable:
#   <top_score>_<duration_s>_<event_id>.jpg
# so the HTML can sort by lowest score / shortest event = most-likely-flicker.
for CAM in hamster_cam_1 hamster_cam_2; do
  EVENTS_JSON="$WORK/$CAM/events.json"
  curl -s "http://127.0.0.1:5000/api/events?after=${SINCE}&cameras=${CAM}&has_snapshot=1&limit=60" \
    > "$EVENTS_JSON"
  python3 - "$EVENTS_JSON" <<'PY' | while IFS=$'\t' read -r EID SCORE DUR; do
import json, sys
for e in json.load(open(sys.argv[1])):
    eid = e.get("id", "")
    score = e.get("top_score") or e.get("data", {}).get("top_score") or 0.0
    start = e.get("start_time") or 0
    end   = e.get("end_time") or start
    dur   = max(0.0, float(end) - float(start))
    print(f"{eid}\t{score:.3f}\t{dur:.1f}")
PY
    OUT_JPG="$WORK/$CAM/${SCORE}_${DUR}_${EID}.jpg"
    curl -s "http://127.0.0.1:5000/api/events/${EID}/snapshot.jpg?bbox=1&crop=0" -o "$OUT_JPG"
    # Drop any snapshot that's suspiciously small (the API can return a tiny
    # JSON error blob with a 200; we don't want broken images in the grid).
    if [ ! -s "$OUT_JPG" ] || [ "$(stat -c%s "$OUT_JPG" 2>/dev/null || stat -f%z "$OUT_JPG")" -lt 2000 ]; then
      rm -f "$OUT_JPG"
    fi
  done
done

# Bundle for scp. Tarball relative to $WORK so paths come out clean.
tar -C "$WORK" -czf /tmp/mask-audit.tar.gz .
echo "$WORK" > /tmp/mask-audit-workdir
REMOTE

scp -q "$HOST:/tmp/mask-audit.tar.gz" "$OUT/_bundle.tar.gz"
ssh "$HOST" 'rm -rf "$(cat /tmp/mask-audit-workdir)" /tmp/mask-audit.tar.gz /tmp/mask-audit-workdir'

tar -xzf "$OUT/_bundle.tar.gz" -C "$OUT"
rm "$OUT/_bundle.tar.gz"

echo "==> Building HTML overlay"
python3 "$SCRIPT_DIR/overlay.py" "$OUT"

echo
echo "Done."
echo "  open $OUT/index.html"
