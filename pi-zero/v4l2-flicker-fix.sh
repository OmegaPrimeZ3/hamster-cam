#!/usr/bin/env bash
#
# v4l2-flicker-fix.sh — re-applies power_line_frequency=2 (60 Hz) to the USB
# camera at /dev/video0 every 5 minutes (via v4l2-flicker-fix.timer).
#
# Why periodic instead of once at service start: the camera's USB controller
# can undergo a kernel-level USB reset (visible in dmesg as "usb 1-1: reset
# full-speed USB device") without causing a Pi reboot or a go2rtc restart.
# After such a reset the UVC driver re-enumerates the device and restores all
# controls to their firmware defaults; the camera's default for this control
# is 1 (50 Hz), which produces horizontal rolling-shutter banding under US
# mains (60 Hz). The ExecStartPre line in go2rtc.service sets 60 Hz on boot
# and on every service restart, but it does NOT fire on a mid-session USB
# reset. This script closes that gap.
#
# On a Pi with no camera attached (or with a camera driver that does not
# expose this control), v4l2-ctl exits non-zero; the leading `-` on the
# ExecStart in the .service unit absorbs that and the timer keeps running.

set -euo pipefail

DEVICE="${V4L2_DEVICE:-/dev/video0}"
TARGET_FREQ=2  # 2 = 60 Hz; 1 = 50 Hz; 0 = disabled

if [[ ! -e "$DEVICE" ]]; then
    # Camera not attached — silent exit so the timer doesn't spam the journal.
    exit 0
fi

current=$(v4l2-ctl -d "$DEVICE" --get-ctrl=power_line_frequency 2>/dev/null \
          | grep -oP 'power_line_frequency:\s*\K[0-9]+' || echo "unknown")

if [[ "$current" == "$TARGET_FREQ" ]]; then
    # Already correct — nothing to do, don't log noise.
    exit 0
fi

# Control drifted (USB reset) — re-apply and log so the journal records it.
printf 'v4l2-flicker-fix: %s power_line_frequency was %s, setting to %s (60 Hz)\n' \
    "$DEVICE" "$current" "$TARGET_FREQ"

v4l2-ctl -d "$DEVICE" --set-ctrl=power_line_frequency="$TARGET_FREQ"

printf 'v4l2-flicker-fix: %s power_line_frequency now %s\n' \
    "$DEVICE" "$(v4l2-ctl -d "$DEVICE" --get-ctrl=power_line_frequency \
                 | grep -oP 'power_line_frequency:\s*\K[0-9]+' || echo '?')"
