#!/usr/bin/env bash
# scripts/cam-health.sh
#
# At-a-glance health check for both Frigate cameras on the live host.
# Prints: container uptime, per-cam fps, ffmpeg crashes, VAAPI/hwdownload
# errors (should be 0 since the 2026-05-28 hwaccel_args fix), and the
# decode-path flags actually in use right now.
#
# Usage:
#   ./scripts/cam-health.sh                # window = since container restart
#   ./scripts/cam-health.sh 5              # window = last 5 minutes
#   ./scripts/cam-health.sh 30 user@host   # custom window + host
#
# Designed to be safe to run any number of times — read-only SSH, no state
# changes on the host.

set -uo pipefail

MINUTES="${1:-}"
HOST="${2:-omegaprime@project-server}"

if [[ -z "$MINUTES" ]]; then
  WINDOW_MODE="restart"   # since current container's StartedAt
  WINDOW_LABEL="since container restart"
else
  WINDOW_MODE="minutes"
  SINCE_FLAG="--since ${MINUTES}m"
  WINDOW_LABEL="last ${MINUTES} min"
fi
SINCE_FLAG="${SINCE_FLAG:-}"

ssh "$HOST" "WINDOW_MODE='$WINDOW_MODE' WINDOW_LABEL='$WINDOW_LABEL' SINCE_FLAG='$SINCE_FLAG' bash -s" <<'REMOTE'
set -uo pipefail

# Resolve --since flag. The "since restart" default uses the container's
# actual StartedAt timestamp — `docker logs` with no --since returns the
# full lifetime log, including pre-restart, which is misleading.
if [[ "$WINDOW_MODE" == "restart" ]]; then
  STARTED_AT=$(docker inspect --format='{{.State.StartedAt}}' hamster-frigate)
  SINCE_FLAG="--since ${STARTED_AT}"
fi

echo "=== window: ${WINDOW_LABEL} ==="
echo

echo "=== container ==="
docker inspect --format='  status: {{.State.Status}}
  started: {{.State.StartedAt}}
  restarts: {{.RestartCount}}' hamster-frigate
echo "  now    : $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
echo

echo "=== detector + per-camera fps ==="
curl -sf http://127.0.0.1:5000/api/stats \
  | jq -r '
    "  inference: \(.detectors.ov.inference_speed) ms",
    "",
    (.cameras | to_entries[] |
      "  \(.key):
    camera_fps     \(.value.camera_fps)
    process_fps    \(.value.process_fps)
    detection_fps  \(.value.detection_fps)
    skipped_fps    \(.value.skipped_fps)
    ffmpeg_pid     \(.value.ffmpeg_pid // "n/a")")'
echo

echo "=== ffmpeg crashes in window ==="
for CAM in hamster_cam_1 hamster_cam_2; do
  N=$(docker logs $SINCE_FLAG hamster-frigate 2>&1 \
        | grep -cE "watchdog\.${CAM}.*Ffmpeg process crashed")
  echo "  ${CAM}: ${N}"
done
echo

echo "=== VAAPI / hwdownload errors in window (should be 0) ==="
N=$(docker logs $SINCE_FLAG hamster-frigate 2>&1 \
      | grep -cE "AVHWFramesContext|hwdownload.*Failed to download frame|Failed to sync surface|scale_vaapi.*error")
echo "  count: ${N}"
echo

echo "=== ffmpeg decode flags actually in use right now ==="
for CAM in hamster_cam_1 hamster_cam_2; do
  FLAGS=$(docker exec hamster-frigate ps auxww 2>/dev/null \
            | grep -E "ffmpeg.*${CAM}" \
            | grep -v grep \
            | head -1 \
            | grep -oE "(-hwaccel [a-z]+|scale_vaapi|scale=[0-9]+:[0-9]+|hwdownload)" \
            | sort -u \
            | tr '\n' ' ')
  if [[ -z "$FLAGS" ]]; then
    echo "  ${CAM}: (ffmpeg not currently running)"
  else
    echo "  ${CAM}: ${FLAGS}"
  fi
done
echo

echo "=== last 5 cam-related ffmpeg errors/warnings in window ==="
docker logs $SINCE_FLAG hamster-frigate 2>&1 \
  | grep -E "hamster_cam_[12]" \
  | grep -iE "error|warning|crashed" \
  | grep -vE "Non-monotonic DTS|RTP: PT=60: bad cseq" \
  | tail -5 \
  | sed 's/^/  /' \
  || echo "  (none)"
REMOTE
