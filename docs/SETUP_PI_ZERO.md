# Pi Zero 2 W setup

Standalone setup guide for the three Pi Zero 2 W camera nodes. Each Pi
runs Raspberry Pi OS Lite, exposes its USB camera as an RTSP stream via
go2rtc, and is locked down with an RTSP password plus a watchdog that
restarts (or reboots) the Pi when go2rtc wedges.

Estimated time: about 30 minutes for the first Pi, then 10-15 minutes
each for the second and third if you clone the first SD card.

For broader context (architecture diagram, hardware bill of materials,
how this fits with the Mac Mini), see [PLAN.md](./PLAN.md).
For Mac Mini setup, see [SETUP_MAC_MINI.md](./SETUP_MAC_MINI.md).


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
  Mac Mini's .env as RTSP_PASSWORD (see PLAN.md section 7.6 and
  .env.example). The same password is used on every Pi.


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
sudo apt install -y v4l-utils ffmpeg curl
```


## Step 4 - Verify the USB camera

```
# Confirm the camera is detected
v4l2-ctl --list-devices
# Should show "Arducam IMX462" or similar

# Check supported formats
v4l2-ctl -d /dev/video0 --list-formats-ext
# You should see MJPEG and YUYV options
```

If `v4l2-ctl --list-devices` shows nothing:
- Try a different USB port or cable.
- Verify you are using the data port (labeled "USB"), not the power
  port (labeled "PWR IN"). The Pi Zero has two micro-USB ports and
  only one of them carries USB data.


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
RTSP_PASSWORD=PASTE_YOUR_LONG_RANDOM_PASSWORD_HERE
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
  camera: exec:ffmpeg -f v4l2 -input_format mjpeg -i /dev/video0 -c copy -f rtsp {output}
```

Frigate on the Mac Mini will pull the stream as:

```
rtsp://hamster:<password>@hamster-cam-1.local:8554/camera
```

The Mac Mini side reads the same password from
`/opt/hamster-cam/.env` as `FRIGATE_RTSP_PASSWORD`. Keep them in sync.


## Step 7 - Install the systemd service and watchdog

The repo ships three files for the Pi:

- `pi-zero/go2rtc.service` - systemd unit with Restart=always and
  EnvironmentFile=/etc/go2rtc/go2rtc.env
- `pi-zero/go2rtc-watchdog.sh` - probes the local go2rtc HTTP and
  RTSP ports; restarts the service on 3 consecutive failures and
  reboots the Pi on 10 consecutive failures
- `pi-zero/go2rtc-watchdog.timer` - runs the watchdog every 60s

Install them from your dev machine:

```
scp pi-zero/go2rtc.service hamster@hamster-cam-1.local:/tmp/
scp pi-zero/go2rtc-watchdog.sh hamster@hamster-cam-1.local:/tmp/
scp pi-zero/go2rtc-watchdog.timer hamster@hamster-cam-1.local:/tmp/

ssh hamster@hamster-cam-1.local '
  sudo mv /tmp/go2rtc.service /etc/systemd/system/
  sudo mv /tmp/go2rtc-watchdog.sh /usr/local/sbin/
  sudo mv /tmp/go2rtc-watchdog.timer /etc/systemd/system/
  sudo chmod +x /usr/local/sbin/go2rtc-watchdog.sh
  sudo chmod 644 /etc/systemd/system/go2rtc.service /etc/systemd/system/go2rtc-watchdog.timer

  sudo systemctl daemon-reload
  sudo systemctl enable --now go2rtc
  sudo systemctl enable --now go2rtc-watchdog.timer
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
- [ ] `systemctl status go2rtc` is "active (running)" on each Pi
- [ ] `systemctl status go2rtc-watchdog.timer` is "active (waiting)"
      on each Pi
- [ ] Each Pi's stream plays in the go2rtc web UI at port 1984
- [ ] Each Pi's RTSP stream plays in VLC with the password
- [ ] The Pi's go2rtc.env file is chmod 600 owned by root


## Common issues

- Camera not detected after a reboot: check that the camera is on
  the data port, not the power port. The Pi Zero only carries USB
  data on one of its two micro-USB jacks.
- Stream black or low FPS: the IMX462 supports hardware MJPEG; the
  default go2rtc config uses MJPEG via `-input_format mjpeg`. If you
  see software encoding chewing the Pi's 512 MB of RAM, confirm
  `v4l2-ctl --list-formats-ext` shows MJPEG and that the config is
  using it (not YUYV).
- "Authentication failed" from Frigate: the password on the Pi
  (`/etc/go2rtc/go2rtc.env`) must match `FRIGATE_RTSP_PASSWORD` in
  the Mac Mini's `.env`.
- Watchdog reboots the Pi in a loop: check `journalctl -u go2rtc -e`
  for the underlying go2rtc error. A bad config or a missing camera
  device will keep tripping the watchdog. Fix the root cause; do not
  disable the watchdog.
