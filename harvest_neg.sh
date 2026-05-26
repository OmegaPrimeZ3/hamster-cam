#!/usr/bin/env bash
# Harvest background NEGATIVES for the hamster model v3 precision pass.
# Runs ON the live host. Pulls recent Frigate event snapshots full-frame
# (bbox=0&crop=0). Right now most events are FALSE POSITIVES (bedding fluff,
# wooden house, reflections) — exactly the frames we want the model to learn
# are NOT a hamster. You'll delete any real-hamster frames after pulling.
set -euo pipefail

OUT="$HOME/cage_neg_harvest"
mkdir -p "$OUT"

# Frigate on the host's internal network (per the tuning runbook).
BASE="http://127.0.0.1:5000"
if ! curl -sf "$BASE/api/version" >/dev/null 2>&1; then
  echo "[harvest] ERROR: Frigate API not reachable at $BASE on the host." >&2
  echo "[harvest] Tell Claude — we'll route through the container instead." >&2
  exit 1
fi

# 2026-05-26 00:00 local onward (post-flicker-fix, current cage state).
AFTER=$(date -d '2026-05-26 00:00:00' +%s)
echo "[harvest] pulling up to 600 event snapshots after $AFTER (full-frame, no bbox)…"

IDS=$(curl -s "$BASE/api/events?after=${AFTER}&cameras=hamster_cam_1,hamster_cam_2&has_snapshot=1&limit=600" \
  | python3 -c "import sys,json; print('\n'.join(e['id'] for e in json.load(sys.stdin)))")

n=0
for id in $IDS; do
  if curl -sf "$BASE/api/events/${id}/snapshot.jpg?bbox=0&crop=0" -o "$OUT/${id}.jpg"; then
    n=$((n+1))
  fi
done

echo "[harvest] wrote $n frames to $OUT ($(du -sh "$OUT" 2>/dev/null | cut -f1))"
echo "[harvest] next: scp these back to the dev Mac, then delete any with a real hamster."
