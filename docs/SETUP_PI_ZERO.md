# Pi Zero 2 W setup

Standalone setup guide for the three Pi Zero 2 W camera nodes. Each Pi
runs Raspberry Pi OS Lite, exposes its USB camera as an RTSP stream via
go2rtc, and is locked down with an RTSP password plus a watchdog that
restarts (or reboots) the Pi when go2rtc wedges.

Estimated time: about 30 minutes for the first Pi, then 10-15 minutes
each for the second and third if you clone the first SD card.

For the architecture diagram and hardware bill of materials see the
[main README](../README.md). For Mac Mini setup, see
[SETUP_MAC_MINI.md](./SETUP_MAC_MINI.md).


## Prerequisites

- One Pi Zero 2 W per camera (three for the standard build)
- A 16 GB microSD card per Pi
- An Arducam IMX462 USB camera per Pi
- A USB-A to micro-USB OTG cable per Pi (the Pi Zero's data port is
  micro-USB; it is labeled "USB", not "PWR IN")
- A 5V 2.5A micro-USB power supply per Pi
- A dev machine with Raspberry Pi Imager installed
- Your home WiFi credentials
- An RTSP password that you have already chosen and recorded in the
  Mac Mini's .env as RTSP_PASSWORD (see [.env.example](../.env.example)).
  The same password is used on every Pi.


## Step 1 - Flash Raspberry Pi OS Lite

On your dev machine:

1. Install Raspberry Pi Imager.
2. Choose "Raspberry Pi OS Lite (64-bit)". The Pi Zero 2 W supports
   64-bit and 64-bit ARM gets better software support than 32-bit.
3. Click the gear icon BEFORE flashing to configure:
   - Hostname: hamster-cam-1 (then -2, -3 for the others)
   - Username/password: hamster / something strong
   - WiFi SSID and password: your home network
   - Locale settings: your timezone
   - Enable SSH: yes, public key authentication
   - Paste your SSH public key from ~/.ssh/id_*.pub
4. Flash the microSD.


## Step 2 - First boot

1. Insert the SD card into the Pi Zero 2 W.
2. Connect the USB camera to the Pi's data port.
3. Plug in power.
4. Wait about 90 seconds for the first boot.
5. From the dev machine: `ssh hamster@hamster-cam-1.local`
6. If `.local` does not resolve, find the IP via your router's DHCP
   table and SSH to the IP instead.


## Step 3 - Initial Pi configuration

On the Pi (over SSH):

```
sudo apt update && sudo apt upgrade -y
sudo apt install -y v4l-utils ffmpeg curl iw
```

- `ffmpeg` (the Raspberry Pi OS build) provides the `h264_v4l2m2m`
  hardware H264 encoder — this is what lets the Pi compress the stream
  on its VideoCore IV block instead of shipping fat MJPEG. See Step 4.
- `iw` is needed to disable WiFi power-save (Step 7).


## Step 3b - Configure NTP time synchronization

**This step is load-bearing.** The Pi Zero 2 W has no hardware real-time
clock. After a power cycle the clock starts at the epoch (or the last saved
timestamp) and can be hours behind the Mac Mini. When the Mac Mini's
zone-visit processor subtracts Pi event times from server times the result
goes negative and diary entries are silently dropped. Correct time is not
cosmetic.

We use `systemd-timesyncd` — it is already on Raspberry Pi OS Lite (no
install required), SNTP accuracy (~10–50 ms) is more than adequate for
camera event timestamps, and it integrates with the same systemd paradigm
as the rest of this stack.

On the Pi (over SSH):

```
# 1. Install the drop-in NTP config (Cloudflare primary, NTP pool fallbacks,
#    aggressive initial polling, SD-friendly save interval).
sudo mkdir -p /etc/systemd/timesyncd.conf.d

# From the dev machine — copy the drop-in, then on the Pi move it into place:
# scp pi-zero/timesyncd.conf hamster@hamster-cam-1.local:/tmp/
# ssh hamster@hamster-cam-1.local "sudo mv /tmp/timesyncd.conf /etc/systemd/timesyncd.conf.d/hamster-cam.conf && sudo chmod 644 /etc/systemd/timesyncd.conf.d/hamster-cam.conf"

# 2. Enable NTP and restart timesyncd to pick up the new config.
sudo timedatectl set-ntp true
sudo systemctl restart systemd-timesyncd
```

Wait ~10 seconds, then verify:

```
timedatectl
# Must show:
#   NTP service: active
#   System clock synchronized: yes

# Also confirm the clock matches the server within a second or two:
date -u   # compare with `date -u` on the Mac Mini — they should agree
```

The one-shot `ntp-sync.service` unit (deployed in Step 7 along with the
go2rtc units) makes this gate explicit: go2rtc declares
`After=ntp-sync.service` so it will not start until a confirmed NTP sync
has completed. This means a Pi that boots into a degraded network (no NTP
reachable) blocks go2rtc for up to 30 seconds rather than writing garbage
timestamps. If NTP is completely unavailable the unit exits anyway (the
`ExecStart=-` absorbs the failure) and go2rtc starts with whatever clock
state exists — the behavior degrades gracefully rather than looping.

The `SaveIntervalSec=600` key in the drop-in causes timesyncd to write the
current time to `/var/lib/systemd/timesync/clock` every 10 minutes. On the
next boot timesyncd reads this file and sets the clock to "last known good
time" before touching the network, so even before NTP contacts the first
server the timestamps are within minutes of reality rather than at epoch.


## Step 4 - Verify the USB camera and the hardware H264 encoder

```
# Confirm the camera is detected
v4l2-ctl --list-devices
# Should show "Arducam IMX462" or similar, plus a "bcm2835-codec-decode"
# / "bcm2835-codec-encode" entry (the VideoCore IV codec block).

# Check supported camera formats
v4l2-ctl -d /dev/video0 --list-formats-ext
# You should see MJPEG (used here) and YUYV. NOTE: this IMX462 only
# advertises 30fps intervals at every resolution, so it always captures
# 30fps regardless of any -framerate request.
```

Now confirm the **hardware H264 encoder** is present and usable — the
Pi encodes H264 on-device, so this must work:

```
# The bcm2835 encoder device node must exist
ls -l /dev/video11           # → present (the H264 HW encoder)

# H264 must be licensed (always is on Pi Zero 2 W / VideoCore IV)
vcgencmd codec_enabled H264  # → H264=enabled

# ffmpeg must expose the hardware encoder wrapper
ffmpeg -hide_banner -encoders | grep h264_v4l2m2m
# → "V..... h264_v4l2m2m   V4L2 mem2mem H.264 encoder wrapper"

# Smoke-test the encoder (synthetic source, no camera needed):
ffmpeg -hide_banner -f lavfi -i testsrc=size=1280x720:rate=30 -frames:v 60 \
  -c:v h264_v4l2m2m -b:v 3M -pix_fmt yuv420p -benchmark -f null -
# → should report "Using device /dev/video11" and finish with speed > 1x
```

If the camera (`v4l2-ctl --list-devices`) shows nothing:
- Try a different USB port or cable.
- Verify you are using the data port (labeled "USB"), not the power
  port (labeled "PWR IN"). The Pi Zero has two micro-USB ports and
  only one of them carries USB data.

If `/dev/video11` is missing or `vcgencmd codec_enabled H264` is not
`enabled`, the firmware codec is off — ensure `dtoverlay` hasn't disabled
it and that you are on a 64-bit Raspberry Pi OS (Bookworm) build.


## Step 5 - Install go2rtc

On the Pi:

```
ARCH=arm64
sudo wget -O /usr/local/bin/go2rtc \
  https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_linux_${ARCH}
sudo chmod +x /usr/local/bin/go2rtc

# Create config and env-file directories
sudo mkdir -p /etc/go2rtc
```


## Step 6 - Lock the RTSP listener

The go2rtc config that ships in this repo at `pi-zero/go2rtc.yaml`
expects an RTSP_PASSWORD environment variable. The password lives in
a root-only env file on the Pi so it never appears on a command line
or in /proc.

On the Pi:

```
# Create the env file with the password (use the same value you
# have in the Mac Mini's .env)
sudo tee /etc/go2rtc/go2rtc.env > /dev/null <<'EOF'
RTSP_PASSWORD=<your-rtsp-password>
EOF
sudo chmod 600 /etc/go2rtc/go2rtc.env
sudo chown root:root /etc/go2rtc/go2rtc.env
```

Then copy the go2rtc config from your dev machine:

```
# From the dev machine
scp pi-zero/go2rtc.yaml hamster@hamster-cam-1.local:/tmp/
ssh hamster@hamster-cam-1.local "sudo mv /tmp/go2rtc.yaml /etc/go2rtc/go2rtc.yaml"
```

The go2rtc.yaml in the repo includes:

```
rtsp:
  username: hamster
  password: ${RTSP_PASSWORD}
streams:
  camera:
    - exec:ffmpeg ... -f v4l2 -input_format mjpeg -framerate 30 -video_size 1280x720 -i /dev/video0 -c:v h264_v4l2m2m -b:v 3M -g 30 -pix_fmt yuv420p -f mpegts -
```

The Pi captures MJPEG from the camera and **hardware-encodes it to H264**
(`-c:v h264_v4l2m2m`, ~3 Mbps at 720p) before it leaves the box. This is
deliberate: two cameras shipping raw 720p MJPEG (~25 Mbps each) saturate
the Pi Zero's 2.4GHz-only radio and cause multi-second live-view lag;
H264 is ~8x smaller and fixes it. Do NOT change `-c:v h264_v4l2m2m` to
`libx264` — the Pi's CPU cannot software-encode H264 in real time; the
VideoCore IV hardware block can.

Two output details that matter (both are in `pi-zero/go2rtc.yaml`):

- **`-f mpegts -` (pipe to stdout), NOT `-f rtsp {output}`.** With the
  RTSP-publish form, go2rtc never resolves the H264 profile from the
  hardware encoder (`profile=None`) and the browser MSE live view hangs
  forever (the `/live/mse/api/ws` socket opens then times out). Piping
  MPEG-TS lets go2rtc parse the in-band SPS/PPS and report `profile=High`,
  which MSE needs. If a live view ever loads as a black box with a
  spinner while snapshots still update, check this first.
- **`-g 30`** sets a keyframe every second — needed for fast live-view
  join and loss recovery (H264 smears on packet loss until the next
  keyframe).

Frigate on the Mac Mini will pull the stream as:

```
rtsp://hamster:<password>@hamster-cam-1.local:8554/camera
```

The Mac Mini side reads the same password from
`/opt/hamster-cam/.env` as `FRIGATE_RTSP_PASSWORD`. Keep them in sync.


## Step 7 - Install the systemd service and watchdog

The repo ships seven files for the Pi:

- `pi-zero/go2rtc.service` - systemd unit with Restart=always and
  EnvironmentFile=/etc/go2rtc/go2rtc.env. Declares `After=ntp-sync.service`
  so it will not start before a confirmed NTP sync (see Step 3b).
- `pi-zero/go2rtc-watchdog.sh` - probes the local go2rtc HTTP and
  RTSP ports; restarts the service on 3 consecutive failures and
  reboots the Pi on 10 consecutive failures
- `pi-zero/go2rtc-watchdog.service` - oneshot unit the timer triggers;
  runs the watchdog script. The timer is bound to this, so it MUST be
  installed or `enable --now` on the timer fails.
- `pi-zero/go2rtc-watchdog.timer` - runs the watchdog every 60s
- `pi-zero/wifi-powersave-off.service` - disables WiFi power management
  on wlan0 at boot. The BCM43430 enables power-save by default, which
  adds latency/jitter and periodic stalls to a continuous stream. This
  is REQUIRED for a smooth live view — it was the decisive fix for the
  multi-camera lag. Needs `iw` (installed in Step 3).
- `pi-zero/ntp-sync.service` - one-shot gate that calls
  `timedatectl set-ntp true`, waits up to 30 s for the first sync, then
  logs the result. go2rtc declares `After=` on this so timestamps are
  always valid before the first frame is written.
- `pi-zero/timesyncd.conf` - drop-in for `/etc/systemd/timesyncd.conf.d/`
  that sets Cloudflare as the primary NTP server, configures aggressive
  initial polling, and sets a 10-minute save interval (protects the SD
  card while still keeping the "last known time" file fresh). See Step 3b.

Install them from your dev machine:

```
scp pi-zero/go2rtc.service hamster@hamster-cam-1.local:/tmp/
scp pi-zero/go2rtc-watchdog.sh hamster@hamster-cam-1.local:/tmp/
scp pi-zero/go2rtc-watchdog.service hamster@hamster-cam-1.local:/tmp/
scp pi-zero/go2rtc-watchdog.timer hamster@hamster-cam-1.local:/tmp/
scp pi-zero/wifi-powersave-off.service hamster@hamster-cam-1.local:/tmp/
scp pi-zero/ntp-sync.service hamster@hamster-cam-1.local:/tmp/
scp pi-zero/timesyncd.conf hamster@hamster-cam-1.local:/tmp/

ssh hamster@hamster-cam-1.local '
  sudo mv /tmp/go2rtc.service /etc/systemd/system/
  sudo mv /tmp/go2rtc-watchdog.sh /usr/local/sbin/
  sudo mv /tmp/go2rtc-watchdog.service /etc/systemd/system/
  sudo mv /tmp/go2rtc-watchdog.timer /etc/systemd/system/
  sudo mv /tmp/wifi-powersave-off.service /etc/systemd/system/
  sudo mv /tmp/ntp-sync.service /etc/systemd/system/
  sudo mkdir -p /etc/systemd/timesyncd.conf.d
  sudo mv /tmp/timesyncd.conf /etc/systemd/timesyncd.conf.d/hamster-cam.conf
  sudo chmod +x /usr/local/sbin/go2rtc-watchdog.sh
  sudo chmod 644 /etc/systemd/system/go2rtc.service \
                 /etc/systemd/system/go2rtc-watchdog.service \
                 /etc/systemd/system/go2rtc-watchdog.timer \
                 /etc/systemd/system/wifi-powersave-off.service \
                 /etc/systemd/system/ntp-sync.service \
                 /etc/systemd/timesyncd.conf.d/hamster-cam.conf

  sudo systemctl daemon-reload
  sudo timedatectl set-ntp true
  sudo systemctl restart systemd-timesyncd
  sudo systemctl enable --now ntp-sync.service
  sudo systemctl enable --now go2rtc
  sudo systemctl enable --now go2rtc-watchdog.timer
  sudo systemctl enable --now wifi-powersave-off.service

  # Confirm NTP is active and clock is synchronized
  timedatectl          # → "NTP service: active", "System clock synchronized: yes"
  # Confirm power-save is now off
  iw dev wlan0 get power_save   # → "Power save: off"
'
```

Why the watchdog matters: a wedged go2rtc process keeps systemd happy
(it has not crashed) but stops feeding frames, and Frigate then sits
forever waiting. The watchdog probes the local HTTP API at port 1984
and the RTSP port; persistent failures escalate from "restart the
service" to "reboot the Pi".


## Step 8 - Verify the stream

From your dev machine:

```
# Open the go2rtc web UI in your browser
open http://hamster-cam-1.local:1984
```

You should see the camera listed. Click the stream name then "stream"
and it should play in the browser.

You can also test RTSP directly with VLC. File -> Open Network ->

```
rtsp://hamster:<password>@hamster-cam-1.local:8554/camera
```

Replace `<password>` with the same value you put in the Pi's
go2rtc.env file.


## Step 9 - Repeat for cameras 2 and 3

Two options.

Option A: repeat steps 1-8 for each Pi from scratch. Slower but
foolproof.

Option B: clone the SD card from the first Pi using `dd`, then on
each clone change the hostname AND regenerate the SSH host keys.
Cloned cards inherit `/etc/ssh/ssh_host_*` from the source - three
Pis sharing one SSH host identity is a real footgun.

After first boot of a cloned SD on Pi 2:

```
# It still has the old hostname at this point
ssh hamster@hamster-cam-1.local

# Rename the host
sudo hostnamectl set-hostname hamster-cam-2
sudo sed -i 's/hamster-cam-1/hamster-cam-2/g' /etc/hosts

# Regenerate this Pi's SSH host identity
sudo rm -f /etc/ssh/ssh_host_*
sudo ssh-keygen -A
sudo systemctl restart ssh

exit
```

On the dev machine, clear the stale known_hosts entry, reconnect, and
reboot the Pi:

```
ssh-keygen -R hamster-cam-2.local
# Reconnect and accept the new SSH host-key fingerprint
ssh hamster@hamster-cam-2.local "sudo reboot"
```

Repeat for hamster-cam-3.


## Verification checklist

Before moving on to Frigate configuration on the Mac Mini, confirm:

- [ ] All three Pis are reachable via SSH at hamster-cam-{1,2,3}.local
- [ ] Each Pi has a unique SSH host key (`ssh-keyscan -t ed25519
      hamster-cam-{1,2,3}.local` returns three different fingerprints)
- [ ] NTP is active and clock is synchronized on each Pi:
      `timedatectl` shows `NTP service: active` and
      `System clock synchronized: yes`
- [ ] The Pi's clock matches the server within 2 seconds:
      `date -u` on the Pi vs `date -u` on the Mac Mini
- [ ] `systemctl status ntp-sync.service` is "active (exited)" on each Pi
- [ ] `systemctl status go2rtc` is "active (running)" on each Pi
- [ ] `systemctl status go2rtc-watchdog.timer` is "active (waiting)"
      on each Pi
- [ ] WiFi power-save is OFF: `iw dev wlan0 get power_save` → `off`
- [ ] The stream is **H264, profile High** (not MJPEG, not profile None):
      `curl -s http://127.0.0.1:1984/api/streams` on the Pi shows the
      producer codec as `h264` / `High`. profile `None` means the exec is
      still publishing via `-f rtsp {output}` instead of piping `-f mpegts -`
      and the browser live view will hang.
- [ ] Each Pi's stream plays in the go2rtc web UI at port 1984
- [ ] Each Pi's RTSP stream plays in VLC with the password
- [ ] The Pi's go2rtc.env file is chmod 600 owned by root


## Common issues

- Camera not detected after a reboot: check that the camera is on
  the data port, not the power port. The Pi Zero only carries USB
  data on one of its two micro-USB jacks.
- Live view loads as a black box / spinner forever, but snapshots
  update: go2rtc could not resolve the H264 profile (`profile=None`).
  Almost always the exec is publishing via `-f rtsp {output}` instead of
  piping `-f mpegts -`. Switch to the pipe form (Step 6) and restart
  go2rtc; confirm `curl http://127.0.0.1:1984/api/streams` reports
  `profile=High`.
- Stream black or capture errors: confirm the camera still does MJPEG
  capture — `v4l2-ctl --list-formats-ext` should show MJPG, and
  `-input_format mjpeg` must be in the exec (raw YUYV at 720p exceeds USB
  2.0 bandwidth). The Pi decodes that MJPEG and re-encodes to H264 on the
  hardware block; if `/dev/video11` disappeared, re-check Step 4.
- Live view smears / blocks up on motion: H264 is sensitive to WiFi
  packet loss. Confirm power-save is off (Step 7); if it persists,
  shorten `-g` (more keyframes) or lower `-b:v` in the exec line.
- "Authentication failed" from Frigate: the password on the Pi
  (`/etc/go2rtc/go2rtc.env`) must match `FRIGATE_RTSP_PASSWORD` in
  the Mac Mini's `.env`.
- Watchdog reboots the Pi in a loop: check `journalctl -u go2rtc -e`
  for the underlying go2rtc error. A bad config or a missing camera
  device will keep tripping the watchdog. Fix the root cause; do not
  disable the watchdog.
