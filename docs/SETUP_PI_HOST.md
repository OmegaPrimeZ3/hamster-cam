# Single-host Pi setup (Pi 5 / Pi 4 / Pi 3 B+)

Alternative to the dual Pi Zero 2 W path in
[`SETUP_PI_ZERO.md`](./SETUP_PI_ZERO.md). Use **one** more-capable Pi to
host **both** USB cameras instead of one Pi Zero per camera.

Estimated time: about 30 minutes for the full bring-up.

For the architecture diagram and overall hardware bill of materials see
the [main README](../README.md). For Mac Mini setup, see
[SETUP_MAC_MINI.md](./SETUP_MAC_MINI.md).


## When to use this path

Pick this over the dual-Pi-Zero path if:

- Your two cameras sit within roughly 3 ft of each other (one Pi between
  them reaches both with stock USB-A cables).
- You want to escape the 2.4 GHz contention soup the Pi Zero W lives in
  (Pi Zero W is 2.4-only, 1×1 11n; Pi 5 / Pi 4 give you 5 GHz, MIMO, and
  optional wired Ethernet).
- You'd rather admin one device than three.
- You can run an Ethernet drop to the camera location (the killer combo
  — the channel-contention conversation ends here forever).

Pick the dual-Pi-Zero path instead if:

- The cameras need to live in physically separate rooms / enclosures.
- You value per-camera fault isolation more than admin consolidation.
- You already have Pi Zero 2 Ws on hand and they're stable for you.


## Board comparison (for this specific role)

| | **Pi 5** | **Pi 4** | **Pi 3 B+** | Pi Zero 2 W |
|---|---|---|---|---|
| CPU | 4× A76 @ 2.4 GHz | 4× A72 @ 1.8 GHz | 4× A53 @ 1.4 GHz | 4× A53 @ 1.0 GHz |
| RAM | 4 / 8 GB | 2 / 4 / 8 GB | 1 GB | 512 MB |
| USB | 2× USB 3.0 + 2× USB 2.0 | 2× USB 3.0 + 2× USB 2.0 | 4× USB 2.0 | 1× micro-USB OTG |
| WiFi | dual-band **ax (WiFi 6)** | dual-band **ac (WiFi 5)** | dual-band **ac (WiFi 5)** | 2.4 GHz **n** only |
| Ethernet | gigabit | gigabit | gigabit (USB-shared, ~300 Mbps real) | none |
| **HW H264 encoder** | **none** (CPU-encode) | yes (VideoCore VI) | yes (VideoCore IV) | yes (VideoCore IV) |
| Power input | USB-C PD (27 W) | USB-C (older PD oddities, mostly fine) | micro-USB | micro-USB |
| Price (8 GB) | ~$80 | ~$75 | ~$40 | ~$15 |

**Recommended choice:** Pi 4 (8 GB) is the **value sweet spot** for this
role — fast enough, has the hardware H264 encoder Pi 5 lost, and saves
the ~$30 cost difference. Pi 5 is the upgrade-future-proof choice and the
right answer if you want to add an NPU/coral later or want WiFi 6 ax.
Pi 3 B+ works but is tight on RAM and USB 2.0 only.

**Skip these:** Pi 3 Model B (non-B+ — 2.4 GHz only, defeats the
contention escape); Pi 2 B (no built-in WiFi, 100 Mbit Ethernet, but
workable if wired); anything older.


## Prerequisites

- One Pi 5 (recommended 8 GB), Pi 4 (8 GB), or Pi 3 B+
- 16 GB microSD card (32 GB if you want comfortable log/journal headroom)
- 2× USB UVC cameras (e.g., Arducam IMX462; same model the Pi Zero path uses)
- 2× short USB-A to USB-A or USB-A to USB-Micro cables (whatever your
  camera presents) — keep these **under 1 m** for clean signal
- **Pi 5:** the official Raspberry Pi 27W USB-C PSU **with USB-PD support**.
  Without PD the Pi 5 caps at 3 A and brownouts the USB cameras under load.
  Do **not** power a Pi 5 from a generic phone charger or a multi-port hub.
- **Pi 4:** the official Raspberry Pi 4 USB-C 15W PSU (or equivalent).
- **Pi 3 B+:** any 5 V 2.5 A micro-USB PSU.
- A dev machine with Raspberry Pi Imager installed
- **Ethernet cable** to the camera location, **OR** WiFi credentials. Wired
  is the better choice if you can reach it — eliminates WiFi as a variable.
- An RTSP password already chosen and recorded in the Mac Mini's `.env` as
  `RTSP_PASSWORD` (see [`.env.example`](../.env.example)).


## Step 1 — Flash Raspberry Pi OS Lite

On your dev machine:

1. Install Raspberry Pi Imager.
2. Choose **Raspberry Pi OS Lite (64-bit)** for all three boards. 32-bit is
   not worth saving 100 MB of RAM.
3. Click the gear icon before flashing to configure:
   - **Hostname:** `hamster-cam` (singular — the consolidated host owns both
     streams; the Mac Mini will reference it as one mDNS host with two
     RTSP paths).
   - **Username/password:** `hamster` / strong password.
   - **WiFi SSID and password:** your home network — **prefer the 5 GHz
     SSID** if you're on a separated-SSIDs setup. (Skip WiFi entirely if
     you're going wired.)
   - **Locale settings:** your timezone.
   - **Enable SSH:** yes, public-key authentication.
   - Paste your SSH public key from `~/.ssh/id_*.pub`.
4. Flash the microSD.


## Step 2 — First boot and SSH in

1. Insert the SD card.
2. **Plug both USB cameras into the Pi's USB-A ports.** On Pi 5 / Pi 4
   prefer the two USB 3.0 ports (the blue ones). On Pi 3 B+ any port works
   since they're all USB 2.0.
3. **Connect Ethernet** if you're going wired, otherwise just WiFi.
4. Plug in power.
5. Wait ~60 seconds for first boot.
6. From the dev machine: `ssh hamster@hamster-cam.local`.
7. If `.local` doesn't resolve, pull the IP from your router / UniFi
   controller DHCP table and SSH to the IP directly.


## Step 3 — Initial Pi configuration

On the Pi (over SSH):

```sh
sudo apt update && sudo apt upgrade -y
sudo apt install -y v4l-utils ffmpeg curl iw
```

- `ffmpeg` here:
  - On Pi 4 / Pi 3 B+, provides `h264_v4l2m2m` (the hardware H264 encoder
    wrapper) the same way it does on the Pi Zero.
  - On Pi 5, provides `libx264` for software encode. **There is no
    hardware H264 encoder on the Pi 5.** Software encode at 720p × 10 fps
    on the quad-A76 is comfortable (~15–20% of one core per camera).
- `iw` is needed only if you're on WiFi (Step 7's power-save fix).


## Step 4 — Configure NTP

Identical to the Pi Zero path — see
[`SETUP_PI_ZERO.md` Step 3b](./SETUP_PI_ZERO.md#step-3b---configure-ntp-time-synchronization).
Copy the same `pi-zero/timesyncd.conf` drop-in into
`/etc/systemd/timesyncd.conf.d/hamster-cam.conf`. The `ntp-sync.service`
gate from the Pi Zero path applies here too — go2rtc must not write
frames before NTP has synced or zone-visit durations will go negative.


## Step 5 — Verify the cameras and pick the encoder path

```sh
# Both cameras should enumerate
v4l2-ctl --list-devices
# Expect TWO camera entries with different /dev/videoN devices (the
# numbering is not guaranteed stable across boots — Step 6 fixes that).
```

Identify each camera's serial / VID:PID — you'll need them in Step 6:

```sh
for dev in /dev/video*; do
  echo "=== $dev ==="
  udevadm info --query=all --name="$dev" | grep -E "ID_SERIAL=|ID_VENDOR_ID=|ID_MODEL_ID=|ID_PATH="
done
```

Check supported formats on each camera:

```sh
v4l2-ctl -d /dev/video0 --list-formats-ext
v4l2-ctl -d /dev/video2 --list-formats-ext   # second camera; the index
                                              # often jumps because each UVC
                                              # device exposes 2 nodes
```

You're looking for `MJPG` support (used here) and ideally `H264` (some
UVC cameras output H264 natively — if yours does, **you skip encoding
entirely** and just `-c:v copy` the stream).

**Pi 5 specific — confirm the hardware encoder is absent (expected):**

```sh
ls -l /dev/video11 2>/dev/null || echo "No HW H264 encoder (expected on Pi 5)"
ffmpeg -hide_banner -encoders 2>/dev/null | grep -E "h264_v4l2m2m|libx264"
# Pi 5: only libx264 should appear.
# Pi 4 / Pi 3 B+: both should appear; we'll use h264_v4l2m2m.
```

**Pi 4 / Pi 3 B+ specific — verify hardware encoder works:**

```sh
ls -l /dev/video11                              # present
vcgencmd codec_enabled H264                     # H264=enabled
ffmpeg -hide_banner -encoders | grep h264_v4l2m2m

# Synthetic smoke test:
ffmpeg -hide_banner -f lavfi -i testsrc=size=1280x720:rate=30 -frames:v 60 \
  -c:v h264_v4l2m2m -b:v 3M -pix_fmt yuv420p -benchmark -f null -
# Reports "Using device /dev/video11", speed > 1x.
```


## Step 6 — Pin stable device names with udev (REQUIRED)

`/dev/video0` and `/dev/video2` can swap on reboot. Pin them by the
camera's USB serial (or path) so `cam1` is always `cam1`.

Grab the identifying attribute for each camera. If both have unique
serials, use that:

```sh
udevadm info --query=property --name=/dev/video0 | grep ID_SERIAL
udevadm info --query=property --name=/dev/video2 | grep ID_SERIAL
```

If both cameras report the same serial (some cheap UVCs do), fall back
to `ID_PATH` (which encodes the USB port location — works as long as you
don't reseat the cables):

```sh
udevadm info --query=property --name=/dev/video0 | grep ID_PATH
udevadm info --query=property --name=/dev/video2 | grep ID_PATH
```

Create the rule file:

```sh
sudo tee /etc/udev/rules.d/99-hamster-cameras.rules > /dev/null <<'EOF'
# Pin each USB UVC camera to a stable name based on its USB serial.
# Replace the ATTRS{serial} values with the ones from `udevadm info`.
# If your cameras share a serial, use ATTRS{devpath} with the port
# location instead (see SETUP_PI_HOST.md Step 6).
KERNEL=="video[0-9]*", SUBSYSTEM=="video4linux", ATTRS{serial}=="CAM_SERIAL_1", SYMLINK+="video-cam1"
KERNEL=="video[0-9]*", SUBSYSTEM=="video4linux", ATTRS{serial}=="CAM_SERIAL_2", SYMLINK+="video-cam2"
EOF

sudo udevadm control --reload-rules
sudo udevadm trigger

# Verify the symlinks exist and point to the right devices
ls -l /dev/video-cam1 /dev/video-cam2
```

From here on the go2rtc config references `/dev/video-cam1` and
`/dev/video-cam2`, **not** the raw `/dev/video0` numbering.


## Step 7 — Install go2rtc

```sh
ARCH=arm64
sudo wget -O /usr/local/bin/go2rtc \
  https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_linux_${ARCH}
sudo chmod +x /usr/local/bin/go2rtc
sudo mkdir -p /etc/go2rtc
```


## Step 8 — Lock the RTSP listener and ship the dual-camera config

Create the env file with the RTSP password (same value as
`FRIGATE_RTSP_PASSWORD` in the Mac Mini's `.env`):

```sh
sudo tee /etc/go2rtc/go2rtc.env > /dev/null <<'EOF'
RTSP_PASSWORD=<your-rtsp-password>
EOF
sudo chmod 600 /etc/go2rtc/go2rtc.env
sudo chown root:root /etc/go2rtc/go2rtc.env
```

Write the go2rtc config. **Two streams**, one per camera. Pick the
encoder line that matches your board:

```sh
sudo tee /etc/go2rtc/go2rtc.yaml > /dev/null <<'EOF'
# Single-host go2rtc serving BOTH UVC cameras. See docs/SETUP_PI_HOST.md.
#
# Device names come from the udev rules in Step 6 — they are STABLE across
# reboots. If you ever see "No such file or directory" on /dev/video-cam{1,2},
# the udev rule didn't match — re-run `udevadm info` and update the serials.
#
# Output pipe (`-f mpegts -`) rather than `-f rtsp {output}` is REQUIRED for
# the browser MSE live view to negotiate an H264 profile. See SETUP_PI_ZERO.md
# go2rtc.yaml header for the full reasoning.

api:
  listen: ":1984"

rtsp:
  listen: ":8554"
  username: hamster
  password: ${RTSP_PASSWORD}

log:
  level: info
  format: text

streams:
  # ===== PI 4 / PI 3 B+ — HARDWARE H264 ENCODER =====
  hamster_cam_1:
    - exec:ffmpeg -hide_banner -loglevel warning -f v4l2 -input_format mjpeg -framerate 15 -video_size 1280x720 -i /dev/video-cam1 -c:v h264_v4l2m2m -b:v 3M -g 15 -pix_fmt yuv420p -f mpegts -
  hamster_cam_2:
    - exec:ffmpeg -hide_banner -loglevel warning -f v4l2 -input_format mjpeg -framerate 15 -video_size 1280x720 -i /dev/video-cam2 -c:v h264_v4l2m2m -b:v 3M -g 15 -pix_fmt yuv420p -f mpegts -

  # ===== PI 5 — SOFTWARE H264 ENCODER (libx264) =====
  # If you're on Pi 5, COMMENT OUT the two blocks above and UNCOMMENT
  # the two blocks below. libx264 ultrafast preset keeps CPU manageable
  # (~15-20% of one A76 core per camera at 720p15).
  #
  # hamster_cam_1:
  #   - exec:ffmpeg -hide_banner -loglevel warning -f v4l2 -input_format mjpeg -framerate 15 -video_size 1280x720 -i /dev/video-cam1 -c:v libx264 -preset ultrafast -tune zerolatency -b:v 3M -g 15 -pix_fmt yuv420p -f mpegts -
  # hamster_cam_2:
  #   - exec:ffmpeg -hide_banner -loglevel warning -f v4l2 -input_format mjpeg -framerate 15 -video_size 1280x720 -i /dev/video-cam2 -c:v libx264 -preset ultrafast -tune zerolatency -b:v 3M -g 15 -pix_fmt yuv420p -f mpegts -

  # ===== EITHER BOARD, IF YOUR CAMERAS OUTPUT H264 NATIVELY =====
  # Some UVC webcams encode H264 themselves — Pi just relays. Zero encode
  # cost on any board.
  #
  # hamster_cam_1:
  #   - exec:ffmpeg -hide_banner -loglevel warning -f v4l2 -input_format h264 -framerate 15 -video_size 1280x720 -i /dev/video-cam1 -c:v copy -f mpegts -
  # hamster_cam_2:
  #   - exec:ffmpeg -hide_banner -loglevel warning -f v4l2 -input_format h264 -framerate 15 -video_size 1280x720 -i /dev/video-cam2 -c:v copy -f mpegts -
EOF

sudo chmod 644 /etc/go2rtc/go2rtc.yaml
```

Frigate on the Mac Mini will pull these as:

```
rtsp://hamster:<password>@hamster-cam.local:8554/hamster_cam_1
rtsp://hamster:<password>@hamster-cam.local:8554/hamster_cam_2
```

Note the **path** is the stream name, not `/camera` (which is what the
single-stream Pi Zero config used). This is what tells go2rtc which of
the two exec blocks to dispatch the request to.


## Step 9 — Install the systemd units (reuse from `pi-zero/`)

The Pi-Zero systemd units already do what we need; the only thing
changing is the go2rtc.yaml's contents (Step 8) and the `ExecStartPre`
line in `go2rtc.service`, which needs to set
`power_line_frequency=2` (anti-flicker) on **both** camera devices
rather than just `/dev/video0`.

Copy the units from the dev machine:

```sh
scp pi-zero/go2rtc.service hamster@hamster-cam.local:/tmp/
scp pi-zero/go2rtc-watchdog.sh hamster@hamster-cam.local:/tmp/
scp pi-zero/go2rtc-watchdog.service hamster@hamster-cam.local:/tmp/
scp pi-zero/go2rtc-watchdog.timer hamster@hamster-cam.local:/tmp/
scp pi-zero/wifi-powersave-off.service hamster@hamster-cam.local:/tmp/
scp pi-zero/ntp-sync.service hamster@hamster-cam.local:/tmp/
scp pi-zero/timesyncd.conf hamster@hamster-cam.local:/tmp/
```

Edit `/tmp/go2rtc.service` on the Pi to add a second `ExecStartPre`
line so the anti-flicker fix is applied to both cameras:

```sh
ssh hamster@hamster-cam.local "sudo sed -i \
  's|ExecStartPre=-/usr/bin/v4l2-ctl -d /dev/video0 --set-ctrl=power_line_frequency=2|ExecStartPre=-/usr/bin/v4l2-ctl -d /dev/video-cam1 --set-ctrl=power_line_frequency=2\nExecStartPre=-/usr/bin/v4l2-ctl -d /dev/video-cam2 --set-ctrl=power_line_frequency=2|' \
  /tmp/go2rtc.service"
```

Then install and enable everything:

```sh
ssh hamster@hamster-cam.local '
  sudo mv /tmp/go2rtc.service /etc/systemd/system/
  sudo mv /tmp/go2rtc-watchdog.sh /usr/local/sbin/
  sudo mv /tmp/go2rtc-watchdog.service /etc/systemd/system/
  sudo mv /tmp/go2rtc-watchdog.timer /etc/systemd/system/
  sudo mv /tmp/wifi-powersave-off.service /etc/systemd/system/
  sudo mv /tmp/ntp-sync.service /etc/systemd/system/
  sudo mkdir -p /etc/systemd/timesyncd.conf.d
  sudo mv /tmp/timesyncd.conf /etc/systemd/timesyncd.conf.d/hamster-cam.conf
  sudo chmod +x /usr/local/sbin/go2rtc-watchdog.sh

  sudo systemctl daemon-reload
  sudo timedatectl set-ntp true
  sudo systemctl restart systemd-timesyncd
  sudo systemctl enable --now ntp-sync.service
  sudo systemctl enable --now go2rtc
  sudo systemctl enable --now go2rtc-watchdog.timer
  sudo systemctl enable --now wifi-powersave-off.service  # skip if wired

  timedatectl
  iw dev wlan0 get power_save 2>/dev/null || echo "wired — skip"
'
```


## Step 10 — Verify both streams

```sh
# go2rtc web UI — both streams should be listed
open http://hamster-cam.local:1984
```

Click each stream then "stream" — both should play in the browser.

RTSP smoke test from your dev machine:

```sh
ffprobe -v error -show_streams \
  rtsp://hamster:<password>@hamster-cam.local:8554/hamster_cam_1
ffprobe -v error -show_streams \
  rtsp://hamster:<password>@hamster-cam.local:8554/hamster_cam_2
```

Both must report:

- `codec_name=h264`
- `profile=High` (NOT `None` — see the go2rtc.yaml header for what `None` means)
- `width=1280`, `height=720`
- `r_frame_rate≈15/1` (whatever you set in the exec)


## Step 11 — Mac Mini side changes

Edit `mac-mini/frigate-config.yml` so both cameras point at the new
single hostname with their respective stream paths:

```yaml
go2rtc:
  streams:
    hamster_cam_1:
      - rtsp://hamster:{FRIGATE_RTSP_PASSWORD}@hamster-cam.local:8554/hamster_cam_1
    hamster_cam_2:
      - rtsp://hamster:{FRIGATE_RTSP_PASSWORD}@hamster-cam.local:8554/hamster_cam_2
```

Update `mac-mini/docker-compose.yml`'s `extra_hosts` (if you have static
IP entries for the Pis): replace the two `hamster-cam-N.local` entries
with one `hamster-cam.local: <Pi's LAN IP>`.

Deploy via `./deploy.sh --sync-frigate-config` (or rsync + restart per
the Mac Mini setup doc).


## Verification checklist

Before moving on, confirm:

- [ ] The Pi is reachable at `hamster-cam.local`
- [ ] NTP is active and synchronized (`timedatectl` shows
      `System clock synchronized: yes`)
- [ ] **Both** `/dev/video-cam1` and `/dev/video-cam2` symlinks exist
      after reboot (`reboot`, wait, then `ls -l /dev/video-cam*`)
- [ ] `systemctl status go2rtc` is `active (running)`
- [ ] `systemctl status go2rtc-watchdog.timer` is `active (waiting)`
- [ ] WiFi power-save is off (or you're on Ethernet)
- [ ] Both streams play in the go2rtc web UI
- [ ] Both `ffprobe` checks return H264 / profile High
- [ ] Frigate on the Mac Mini shows both cameras with non-zero
      `camera_fps` (run `scripts/cam-health.sh` from the dev machine)


## Common issues

- **One camera works, the other doesn't.** Almost always the udev rule
  didn't match. `udevadm info --query=property --name=/dev/video0 |
  grep ID_SERIAL` and confirm the serial in
  `/etc/udev/rules.d/99-hamster-cameras.rules` matches. If both cameras
  share a serial, switch to pinning by `ATTRS{devpath}` or `ID_PATH`.
- **Camera order swapped after a reboot.** The udev rules aren't
  applying. Run `sudo udevadm test /sys/class/video4linux/video0` and
  read the output for which rule (if any) matches.
- **Pi 5: live view is choppy, CPU is high.** `libx264 -preset
  ultrafast -tune zerolatency` is what you want for low CPU. If you
  copied from the Pi 4 block you may have `h264_v4l2m2m` in there,
  which fails silently on Pi 5 because there's no `/dev/video11`.
- **Pi 5: USB cameras keep brownouting / disconnecting.** You're
  probably not on a PD-capable PSU. The Pi 5 needs to negotiate 5A via
  USB-PD; without it the USB bus current is capped. Use the official
  Pi 27 W PSU.
- **`/dev/video11` missing on Pi 4 / Pi 3 B+** — verify you're on
  Bookworm or later (not an old Buster image) and that `vcgencmd
  codec_enabled H264` returns `H264=enabled`.
- **Live view shows black frame, snapshots work.** go2rtc resolved
  `profile=None` — the exec block is using `-f rtsp {output}` instead
  of `-f mpegts -`. Switch to the pipe form, restart go2rtc, confirm
  via `curl http://127.0.0.1:1984/api/streams`.
- **`hamster-cam.local` doesn't resolve from the Mac Mini.** mDNS
  flakes; pin the IP in `mac-mini/docker-compose.yml`'s `extra_hosts`.
- **Both cameras at low fps under load.** Both are on the same USB 3.0
  controller; check `dmesg | grep -i usb` for bus errors. On Pi 3 B+
  (USB 2.0 only) two simultaneous MJPEG captures at 720p × 30 fps
  saturate the bus — drop `-framerate` to 15 or `-video_size` to 640×480
  on one of the streams.


## When to come back to this doc

- After the cable swap on a flaky Pi Zero W setup, if you decide to
  consolidate
- When upgrading from 2×Pi Zero 2 W to a single more capable host
- When adding a third camera (the Pi 5 / Pi 4 have free USB ports — add
  a third `streams.hamster_cam_3` block and a third udev rule)
