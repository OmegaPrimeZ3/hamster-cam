#!/usr/bin/env bash
#
# go2rtc-watchdog.sh — probes go2rtc's HTTP API and RTSP listener and
# escalates from "restart the service" to "reboot the Pi" on persistent
# failure.
#
# A wedged go2rtc process keeps systemd happy (it hasn't crashed) but stops
# feeding frames, and Frigate then sits forever waiting. This watchdog is
# the safety net.
#
# Counter state persists at /run/go2rtc-watchdog.count across runs. The
# /run tmpfs is wiped on boot — fine, a freshly booted Pi should start
# counting from zero.
#
# Escalation:
#   3 consecutive failures -> systemctl restart go2rtc, reset counter
#  10 consecutive failures -> systemctl reboot
#
# Exit 0 always, even on probe failure — we don't want the .timer to enter
# `failed` state and stop firing.

set -euo pipefail

readonly STATE_FILE=/run/go2rtc-watchdog.count
readonly API_URL=http://localhost:1984/api/streams
readonly RTSP_HOST=localhost
readonly RTSP_PORT=8554
readonly RESTART_THRESHOLD=3
readonly REBOOT_THRESHOLD=10

log() {
    # systemd will scoop these into the journal for us via the .service unit.
    printf '%s\n' "go2rtc-watchdog: $*"
}

read_count() {
    if [[ -r "$STATE_FILE" ]]; then
        local value
        value=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
        # Defend against a corrupted state file (non-numeric content).
        if [[ "$value" =~ ^[0-9]+$ ]]; then
            printf '%s' "$value"
        else
            printf '0'
        fi
    else
        printf '0'
    fi
}

write_count() {
    printf '%s\n' "$1" > "$STATE_FILE"
}

probe_http() {
    # -sf: silent + fail-on-HTTP-error. --max-time guards against the API
    # hanging when go2rtc is alive-but-wedged.
    curl -sf --max-time 5 "$API_URL" > /dev/null
}

probe_rtsp() {
    # nc -z does a connect-only probe. -w bounds the wait so a half-open
    # socket can't hold us forever.
    nc -z -w 5 "$RTSP_HOST" "$RTSP_PORT"
}

main() {
    local count
    count=$(read_count)

    if probe_http && probe_rtsp; then
        if (( count > 0 )); then
            log "probes ok — clearing failure count (was $count)"
        fi
        write_count 0
        exit 0
    fi

    count=$(( count + 1 ))
    write_count "$count"
    log "probes failed (consecutive: $count)"

    if (( count >= REBOOT_THRESHOLD )); then
        log "reached reboot threshold ($REBOOT_THRESHOLD); rebooting Pi"
        # Reset before the reboot so we don't reboot-loop instantly on the
        # post-boot watchdog run if go2rtc takes a moment to come up.
        write_count 0
        systemctl reboot
        exit 0
    fi

    if (( count >= RESTART_THRESHOLD )); then
        log "reached restart threshold ($RESTART_THRESHOLD); restarting go2rtc"
        if systemctl restart go2rtc; then
            log "restart succeeded; clearing failure count"
            write_count 0
        else
            log "restart failed; leaving counter at $count for next probe"
        fi
        exit 0
    fi

    exit 0
}

main "$@"
