# Mac Mini setup

Standalone setup guide for the Mac Mini that acts as the brain of the
hamster-cam system. The Mini runs Ubuntu Server, hosts the Docker
Compose stack (Mosquitto, Frigate, Caddy, cloudflare-ddns), runs
Frigate's AI inference on the Intel iGPU via OpenVINO, and serves the
React app.

Estimated time: about 2 hours total spread across base OS install
(~1 hour), services bring-up (~45 min), and Frigate configuration
(~30 min once the Pi Zeros are streaming).

For the architecture diagram and hardware bill of materials, see the
[main README](../README.md). For Pi Zero setup, see
[SETUP_PI_ZERO.md](./SETUP_PI_ZERO.md). For the env-var reference, see
[.env.example](../.env.example) at the repo root.


## Prerequisites

- One Mac Mini (2018 Intel i5/i7 recommended; an Apple Silicon Mini
  works but will need the Apple Silicon Asahi/Ubuntu instructions
  and Frigate will use CPU inference instead of OpenVINO)
- A USB stick for the Ubuntu installer (8 GB or larger)
- A USB keyboard and an HDMI monitor for the first boot
- Your home WiFi credentials (or an ethernet cable, preferred for
  the brain)
- A dev machine for SSH access
- The repo cloned on the dev machine


## Path choice: Linux vs macOS

You have two real choices.

| Path | Pros | Cons |
|---|---|---|
| **Ubuntu Server (recommended)** | Full OpenVINO acceleration on the UHD 630 iGPU. Lower idle resource use. No Docker Desktop VM overhead. | One-time T2 chip wrangling on 2018/2020 Intel Minis. Wipes macOS. |
| **macOS + Docker Desktop** | No reformatting. Familiar environment. | Needs a Coral USB Accelerator ($60) for Frigate inference. 2-4 GB RAM goes to the Docker Desktop VM. |

The rest of this doc takes the Ubuntu path. The macOS path differs
only in section 1 (no Ubuntu install needed) and section 3 (use a
Coral USB stick instead of OpenVINO drivers). The Docker Compose
content, Frigate config, and app deployment are identical.


## Step 1 - Install Ubuntu Server 24.04 LTS

The 2018/2020 Intel Mac Mini has a T2 security chip that complicates
Linux installation. The cleanest path is the t2linux.org Ubuntu guide.

1. **Disable Secure Boot.** Boot into macOS Recovery (Cmd+R at
   startup). Open Startup Security Utility. Set "Secure Boot" to
   "No Security". Set "External Boot" to "Allow booting from
   external media".

2. **Create a Ubuntu USB installer** using balenaEtcher or `dd`.
   Use the Ubuntu 24.04 LTS Server ISO.

3. **Apply T2 patches.** Follow the
   [t2linux.org Ubuntu installation guide](https://wiki.t2linux.org/distributions/ubuntu/installation/)
   exactly. The standard Ubuntu installer will install fine, but
   their post-install steps are needed for audio, suspend, and
   WiFi drivers.

4. **During install:**
   - Use the full disk.
   - Install OpenSSH Server (essential - you do not want to keep a
     monitor and keyboard attached to the Mini).
   - Skip the snap selections; install what you need from apt.
   - Create user `hamster` with a strong password.

5. **After install, on the Mac Mini console:**

   ```sh
   sudo apt update && sudo apt upgrade -y
   sudo apt install -y curl git build-essential vim htop

   # Get the IP for SSH from your dev machine
   ip addr show | grep "inet "
   ```

6. **From your dev machine, SSH in:**

   ```sh
   ssh hamster@<mac-mini-ip>
   ```

7. **Set up SSH key auth** so you stop typing the password:

   ```sh
   # On the dev machine
   ssh-copy-id hamster@<mac-mini-ip>
   ```

8. **Reserve a static DHCP lease** for the Mac Mini in your router
   so its LAN IP does not drift. Note its MAC address from
   `ip link show`. You will need a stable LAN IP for the port-forward
   step further down in this guide.


## Step 2 - Install Docker

```sh
# On the Mac Mini
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker hamster
# Log out and back in for the docker group to take effect
```

Verify:

```sh
docker run hello-world
```


## Step 3 - Install OpenVINO drivers (Intel iGPU acceleration)

Skip this section if you took the macOS path - use a Coral USB
Accelerator instead.

```sh
sudo apt install -y intel-opencl-icd intel-media-va-driver-non-free
sudo reboot
```

After reboot, verify:

```sh
sudo usermod -aG video,render $USER
# Logout and back in

sudo apt install -y vainfo
vainfo
```

You should see the Intel iHD driver listed. If vainfo errors out,
re-check the t2linux.org post-install steps - the iGPU is one of
the things their patches sometimes need.


## Step 4 - Set up the host directories

```sh
# On the Mac Mini
sudo mkdir -p /opt/hamster-cam/{config,storage,db,storage/timelapse}
sudo chown -R hamster:hamster /opt/hamster-cam
cd /opt/hamster-cam
```

| Path | Purpose |
|---|---|
| `/opt/hamster-cam/.env` | Environment variables consumed by docker-compose and the app. Chmod 600 once populated. |
| `/opt/hamster-cam/frigate-config.yml` | Frigate config. Lives at the root — compose mounts `./frigate-config.yml`. |
| `/opt/hamster-cam/mosquitto/`, `caddy/`, `fail2ban/` | Per-service config dirs, bind-mounted by compose from the root. |
| `/opt/hamster-cam/storage/` | Frigate recordings, snapshots, nightly time-lapse MP4s |
| `/opt/hamster-cam/db/` | SQLite database `hamster.db` and dated backup copies |


## Step 5 - Create the .env file

Copy `.env.example` from the repo to the Mac Mini and fill in the
real values. Reference [.env.example](../.env.example) at the repo
root for the full annotated list.

```sh
# From the dev machine
scp .env.example hamster@<mac-mini-ip>:/opt/hamster-cam/.env

# On the Mac Mini
chmod 600 /opt/hamster-cam/.env
# Edit and fill in real values
vim /opt/hamster-cam/.env
```

Critical values to have ready:

| Variable | Where to get it |
|---|---|
| `ZYPHR_API_KEY` | Zyphr.dev dashboard, "API Keys" |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard, My Profile > API Tokens, scoped to `Zone:DNS:Edit` on your zone |
| `RTSP_PASSWORD` / `FRIGATE_RTSP_PASSWORD` | Generated, then mirrored to each Pi's `/etc/go2rtc/go2rtc.env`. `openssl rand -base64 24` is fine. |
| `MQTT_PASSWORD` | Generated. Used by Mosquitto, Frigate, and the backend. |


## Step 6 - Copy infra configs to the Mac Mini

```sh
# From the dev machine, in the repo root
scp mac-mini/docker-compose.yml omegaprime@project-server:/opt/hamster-cam/
scp mac-mini/frigate-config.yml hamster@<mac-mini-ip>:/opt/hamster-cam/
scp -r mac-mini/caddy hamster@<mac-mini-ip>:/opt/hamster-cam/
scp -r mac-mini/fail2ban hamster@<mac-mini-ip>:/opt/hamster-cam/
scp -r mac-mini/mosquitto hamster@<mac-mini-ip>:/opt/hamster-cam/
```

Every config lands at the **project root** (`/opt/hamster-cam/`), because
that is where `docker-compose.yml`'s relative bind mounts resolve from —
`./frigate-config.yml`, `./mosquitto/`, `./caddy/`, `./fail2ban/`. Do
**not** tuck `frigate-config.yml` into a `config/` subdirectory: the
compose mount is `./frigate-config.yml:/config/config.yml`, so if the
file isn't at the root, Docker silently creates an empty *directory* in
its place, Frigate finds no config, logs `No config file found, saving
default config`, and boots with **zero cameras** — a clean startup with
an empty UI. Same trap as Mosquitto below.

The `mosquitto/` directory ships `mosquitto/config/mosquitto.conf`, which
the compose file bind-mounts into the broker container. If you skip it,
Docker auto-creates an empty host directory on first bring-up and
Mosquitto refuses to start with `Unable to open config file
/mosquitto/config/mosquitto.conf`.


## Step 7 - Start Mosquitto first

We bring Mosquitto up first because both Frigate and the app need it,
and you can validate it quickly before adding more moving parts.

### 7.1 - Create the MQTT passwd file

`mac-mini/mosquitto/config/mosquitto.conf` has `allow_anonymous false`
and references `password_file /mosquitto/config/passwd`. The passwd
file is not in git (it holds a hashed credential) and must be created
once on the Mac Mini before the broker accepts any client.

Source `.env` so `$MQTT_USERNAME` and `$MQTT_PASSWORD` are populated,
then run `mosquitto_passwd` inside a throwaway broker container so it
writes the file into the mounted config volume:

```sh
# On the Mac Mini
cd /opt/hamster-cam
set -a; . ./.env; set +a
docker compose run --rm --entrypoint sh mosquitto -c \
  "mosquitto_passwd -b -c /mosquitto/config/passwd \"$MQTT_USERNAME\" \"$MQTT_PASSWORD\" && chmod 600 /mosquitto/config/passwd"
```

Verify the file landed on the host:

```sh
ls -la mosquitto/config/passwd   # should be -rw------- and owned by you
```

### 7.2 - Start the broker

```sh
docker compose up -d mosquitto
docker compose logs -f mosquitto
```

Verify:

```sh
# MQTT is listening on port 1883 (bound to localhost per docker-compose.yml)
ss -tlnp | grep 1883

# The compose healthcheck authenticates with $MQTT_USERNAME / $MQTT_PASSWORD;
# once it goes green the broker is accepting authenticated clients.
docker compose ps mosquitto
```

You should see Mosquitto listening on `127.0.0.1:1883` and
`docker compose ps` reporting `Up (healthy)` within ~10 seconds.


## Step 8 - Configure Frigate

Frigate is configured via `/opt/hamster-cam/frigate-config.yml` (the
compose file mounts it to `/config/config.yml` inside the container).
The repo ships a template that pulls camera credentials from the
`.env` file.

### 8.1 - Camera URLs

The template defines three cameras. Each pulls its stream from a Pi
using the password from `.env`:

```yaml
cameras:
  hamster_cam_1:
    ffmpeg:
      inputs:
        - path: rtsp://hamster:{FRIGATE_RTSP_PASSWORD}@hamster-cam-1.local:8554/camera
          roles: [detect, record]
  # ...hamster_cam_2 and hamster_cam_3 similarly
```

Confirm the three Pi Zeros are streaming (see
[SETUP_PI_ZERO.md](./SETUP_PI_ZERO.md)) before bringing Frigate up.

### 8.2 - Let Docker resolve the cameras' `.local` names

The camera URLs in `frigate-config.yml` use mDNS names
(`hamster-cam-1.local`, etc.). Your Mac Mini host resolves these via
Avahi, but **Docker's container resolver does not speak mDNS** — so
without this step Frigate starts cleanly but shows no video, because
ffmpeg inside the container can't resolve the camera hostnames. The Pis
are fine; the name lookup is what fails.

The simplest, most robust fix is a static map: give each Pi a fixed IP
and tell the Frigate container how to reach the `.local` names directly.
No host daemons, survives reboots.

1. **Reserve a static IP for each Pi** in your router's DHCP settings
   (bind to the Pi's MAC address). This keeps the IP from drifting.
   Find each Pi's current IP and MAC from the router's client list, or
   on the Mac Mini host (which *can* resolve mDNS):

   ```sh
   getent hosts hamster-cam-1.local
   getent hosts hamster-cam-2.local
   ```

2. **Map the names to those IPs** in the `frigate` service of
   `docker-compose.yml` — replace the placeholders:

   ```yaml
   extra_hosts:
     - "hamster-cam-1.local:192.168.1.51"   # ← your reserved IPs
     - "hamster-cam-2.local:192.168.1.52"
   ```

> Why not make Docker speak mDNS instead? You can (systemd-resolved with
> `MulticastDNS=yes` + a `DNSStubListenerExtra` the containers reach,
> then point `/etc/docker/daemon.json` `"dns"` at it) — but it's a
> daemon-wide change that's fiddly on hosts where the default `docker0`
> bridge is down and the stack runs on a user-defined network. For a
> handful of fixed cameras, the static map above is less to go wrong.

### 8.3 - Start Frigate

The `frigate-config.yml` template references `{FRIGATE_RTSP_PASSWORD}`,
`{MQTT_USERNAME}`, and `{MQTT_PASSWORD}`. Compose injects those into the
container by interpolating the matching `${...}` values in
`docker-compose.yml` — and it only finds them if `.env` is loaded.
Compose auto-loads `.env` from the **project directory**, so either run
from `/opt/hamster-cam` or pass `--env-file` explicitly. If the vars are
missing, compose substitutes an empty string with only a warning,
Frigate sends a blank RTSP password, every Pi answers `401`, and the
cameras come up **black with no video** even though startup looks clean.

```sh
cd /opt/hamster-cam
docker compose --env-file .env up -d frigate
docker compose logs -f frigate
```

Before opening the UI, confirm the password actually reached the
container (this is the single most common cause of black cameras):

```sh
docker exec hamster-frigate sh -c 'echo "[$FRIGATE_RTSP_PASSWORD]"'
```

It must print the real password in the brackets. An empty `[]` means
`.env` wasn't loaded — recreate the container from the command above. (A
plain `restart` will not re-read the environment; it must be recreated.)

Frigate's web UI is at `http://<mac-mini-ip>:5000`. You should see
all three cameras live within a minute or two.

> **"This site can't be reached"?** First confirm the container bound
> the host port: `docker compose ps` (frigate should be `running`, not
> restarting) and `sudo lsof -nP -iTCP:5000 -sTCP:LISTEN`.
>
> **macOS path only:** Control Center / AirPlay Receiver squats on port
> 5000, so Docker can't bind it and the container won't start. Free it
> via **System Settings → General → AirDrop & Handoff → turn off
> "AirPlay Receiver."** (Ubuntu has nothing on 5000 by default.)
>
> The Frigate UI has no auth — it's published to the LAN only; never
> forward port 5000 at your router.

### 8.4 - Define zones

For each camera, define rectangular zones over the wheel, food bowl,
and water bottle areas. Frigate has a built-in zone editor.

1. Open the Frigate UI at `http://<mac-mini-ip>:5000`.
2. Click a camera, then "Edit Config" in the camera view.
3. Use the zone editor to draw boxes over the wheel, food, and water.
4. Save. Frigate writes the resulting `zones:` block back into
   `frigate-config.yml`.
5. Restart Frigate to apply: `docker compose restart frigate`.

The zone names matter - the narrator code on the backend looks for
specific zone names (`wheel`, `food`, `water`, etc.). Match the
names used in `app/server/src/narratives.ts`.

### 8.5 - Detection model

Frigate's default model does not recognize "hamster". You have two
realistic options.

**Quick path: lenient generic classes.** Edit `frigate-config.yml`
to track `mouse` or `cat` with a very low `min_score` (e.g. 0.30).
Often works well enough for one stationary cage.

**Better path: train a custom YOLO on Roboflow.**

1. Use Frigate's snapshot feature to collect 200-500 photos of your
   pet from each camera angle. Snapshots are timestamped and free.
2. Upload to Roboflow, label "hamster" bounding boxes.
3. Train a YOLOv8n model on Roboflow's free tier (about 30 minutes).
4. Export to ONNX or OpenVINO IR format.
5. Replace the `model:` block in `frigate-config.yml` with a path
   to your custom model.
6. Restart Frigate.

### 8.6 - Verify detection

Watch the Frigate debug view in the web UI. Bounding boxes should
appear when the hamster is visible. Tune `min_score` and zone
thresholds until false positives are minimal but the hamster is
reliably detected.


## Step 9 - Bring up the rest of the stack

Once Mosquitto and Frigate are healthy:

```sh
cd /opt/hamster-cam
docker compose up -d cloudflare-ddns caddy
docker compose ps
docker compose logs -f
```

Wait for Caddy to issue its Let's Encrypt cert via the Cloudflare
DNS-01 challenge. You should see "certificate obtained successfully"
in the Caddy logs within about 30 seconds. If it does not, double-check
your `CLOUDFLARE_API_TOKEN` scope (must be `Zone:DNS:Edit` on the one
zone) and that the `CADDY_HOSTNAME` matches the A record at Cloudflare.


## Step 10 - Deploy the app

The application backend and frontend are deployed from the dev
machine via `deploy.sh` at the repo root. The script rsyncs the
prebuilt server `dist/` and web `dist/` directories to
`MAC_MINI_PATH` over SSH and restarts the `hamster-app` systemd
service.

After the first deploy installs the `hamster-app` systemd service:

```sh
# On the Mac Mini, one-time
cd /opt/hamster-cam/app
sudo cp hamster-app.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hamster-app
sudo systemctl status hamster-app
```


## Step 11 - Bootstrap the first admin

There is no in-app "create admin" form (anyone with access to the
public URL could grab admin if there were). Bootstrap the first
admin once on the Mac Mini:

```sh
cd /opt/hamster-cam/app
pnpm hamster bootstrap-admin \
  --email you@example.com \
  --display-name "Dad" \
  --password "$(openssl rand -base64 24)"
```

Record the password somewhere safe. After this, sign in normally via
the login screen, and create every subsequent account (children,
co-admins, etc.) from Settings > Users in the running app.


## Verification checklist

Before declaring the Mac Mini ready, confirm:

- [ ] `ssh hamster@<mac-mini-ip>` works with key auth (no password)
- [ ] Static DHCP lease reserved for the Mini's MAC address
- [ ] `docker run hello-world` succeeds
- [ ] `vainfo` shows the Intel iHD driver (Linux path only)
- [ ] `/opt/hamster-cam/.env` exists, chmod 600, with real values
- [ ] `docker compose ps` shows mosquitto, frigate, caddy, and
      cloudflare-ddns all `Up (healthy)`
- [ ] Frigate web UI at port 5000 shows all three cameras live
- [ ] Frigate zones are defined for each camera
- [ ] `ss -tlnp` shows Caddy listening on the configured non-standard
      HTTPS port (default 2053)
- [ ] Caddy log shows "certificate obtained successfully"
- [ ] `systemctl status hamster-app` is "active (running)"
- [ ] Bootstrap admin can sign in via the login screen at the
      Cloudflare-proxied URL


## Common issues

- **Frigate restarts in a loop** with "cannot find /dev/dri": the
  OpenVINO drivers are not installed or the iGPU is not exposed to
  the container. Re-check step 3 (vainfo) and the
  `device_cgroup_rules` in `mac-mini/docker-compose.yml`.
- **Caddy fails to obtain a cert**: usually a Cloudflare API token
  scope problem. The token needs `Zone:DNS:Edit` on the specific
  zone, not "All zones".
- **Frigate streams are black** or show "Cannot open RTSP source":
  check the password in `.env` matches each Pi's
  `/etc/go2rtc/go2rtc.env`. Test the URL directly with VLC.
- **MQTT events are not flowing** to the backend: confirm Mosquitto
  has username/password auth enabled (no anonymous access) and that
  both Frigate and the backend use the same `MQTT_PASSWORD`.
- **OpenVINO inference is slow on 2018 Mini**: the UHD 630 is fine
  for three cameras at 720p/15fps. If it is overloaded, drop fps
  per camera in `frigate-config.yml` before adding hardware.
