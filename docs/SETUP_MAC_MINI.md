# Mac Mini setup

Standalone setup guide for the Mac Mini that acts as the brain of the
hamster-cam system. The Mini runs Ubuntu Server and hosts the Docker
Compose stack: Mosquitto, Frigate, Caddy, cloudflare-ddns, and the
hamster-app container. Frigate's AI inference runs on the Intel UHD 630
iGPU via OpenVINO.

Estimated time: ~2 hours total — base OS (~1 hour), services bring-up
(~45 min), and Frigate camera configuration (~30 min once the Pi Zeros
are streaming).

For the architecture diagram and hardware bill of materials, see the
[main README](../README.md). For Pi Zero setup, see
[SETUP_PI_ZERO.md](./SETUP_PI_ZERO.md). For the full env-var reference,
see [`.env.example`](../.env.example) at the repo root.


## Prerequisites

- One Mac Mini (2018 Intel i5/i7 recommended; Apple Silicon works but
  Frigate will use CPU inference instead of OpenVINO)
- A USB stick for the Ubuntu installer (8 GB or larger)
- A USB keyboard and HDMI monitor for the first boot
- Your home WiFi credentials (or ethernet — preferred for the brain)
- A dev machine for SSH access, with the repo cloned on it


## Path choice: Linux vs macOS

| Path | Pros | Cons |
|---|---|---|
| **Ubuntu Server (recommended)** | Full OpenVINO acceleration on the UHD 630 iGPU. Lower idle resource use. No Docker Desktop VM overhead. | One-time T2 chip wrangling on 2018/2020 Intel Minis. Wipes macOS. |
| **macOS + Docker Desktop** | No reformatting. Familiar environment. | Needs a Coral USB Accelerator ($60) for Frigate inference. 2-4 GB RAM goes to the Docker Desktop VM. |

The rest of this doc takes the Ubuntu path. The macOS path differs only
in Step 1 (no Ubuntu install needed) and Step 3 (use a Coral USB stick
instead of OpenVINO drivers). The Docker Compose content, Frigate
config, and app deployment are identical.


## Step 1 — Install Ubuntu Server 24.04 LTS

The 2018/2020 Intel Mac Mini has a T2 security chip that complicates
Linux installation. Use the [t2linux.org Ubuntu guide](https://wiki.t2linux.org/distributions/ubuntu/installation/).

1. **Disable Secure Boot.** Boot into macOS Recovery (Cmd+R at
   startup). Open Startup Security Utility. Set "Secure Boot" to
   "No Security". Set "External Boot" to "Allow booting from
   external media".

2. **Create a Ubuntu USB installer** using balenaEtcher or `dd`.
   Use the Ubuntu 24.04 LTS Server ISO.

3. **Apply T2 patches.** Follow the t2linux.org Ubuntu installation
   guide exactly. The standard Ubuntu installer works fine, but their
   post-install steps are needed for audio, suspend, and WiFi drivers.

4. **During install:**
   - Use the full disk.
   - Install OpenSSH Server (you will not want a monitor attached
     to the Mini after first boot).
   - Skip the snap selections.
   - Create a user (e.g. `YOUR_USERNAME`) with a strong password.

5. **After install, on the Mac Mini console:**

   ```sh
   sudo apt update && sudo apt upgrade -y
   sudo apt install -y curl git build-essential vim htop
   ip addr show | grep "inet "   # note the IP for SSH
   ```

6. **From your dev machine, SSH in:**

   ```sh
   ssh YOUR_USERNAME@<mac-mini-ip>
   ```

7. **Set up SSH key auth** so you stop typing the password:

   ```sh
   # On the dev machine
   ssh-copy-id YOUR_USERNAME@<mac-mini-ip>
   ```

8. **Reserve a static DHCP lease** for the Mac Mini in your router
   using its MAC address from `ip link show`. A stable LAN IP is
   required for the port-forward step later.


## Step 2 — Install Docker

```sh
# On the Mac Mini
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
# Log out and back in for the docker group to take effect
docker run hello-world   # verify
```


## Step 3 — Install OpenVINO drivers (Intel iGPU acceleration)

*Skip this step if you are using the macOS path — use a Coral USB
Accelerator instead.*

```sh
sudo apt install -y intel-opencl-icd intel-media-va-driver-non-free
sudo usermod -aG video,render "$USER"
sudo reboot
```

After reboot:

```sh
sudo apt install -y vainfo
vainfo   # should show Intel iHD driver
```

If `vainfo` errors, re-check the t2linux.org post-install steps — the
iGPU driver is one of the things their patches may need.


## Step 4 — Set up host directories

```sh
# On the Mac Mini
# Chown to the user that deploy.sh SSHes in as (here: YOUR_USERNAME).
# The container's bind-mounts under ./db and ./storage must be owned
# by the same UID the container runs as (see HOST_UID in .env.example).
sudo mkdir -p /opt/hamster-cam/{storage,db,storage/timelapse}
sudo chown -R "$USER":"$USER" /opt/hamster-cam
```

| Path | Purpose |
|---|---|
| `/opt/hamster-cam/.env` | Environment variables for the stack. chmod 600 once populated. |
| `/opt/hamster-cam/frigate-config.yml` | Frigate config. Compose mounts `./frigate-config.yml`. |
| `/opt/hamster-cam/mosquitto/` | Mosquitto config dir, bind-mounted by compose. |
| `/opt/hamster-cam/caddy/` | Caddy Dockerfile + Caddyfile, bind-mounted by compose. |
| `/opt/hamster-cam/fail2ban/` | fail2ban jail + filter files, bind-mounted by compose. |
| `/opt/hamster-cam/storage/` | Frigate recordings, snapshots, nightly time-lapse MP4s. |
| `/opt/hamster-cam/db/` | SQLite database `hamster.db` and dated backup copies. |


## Step 5 — Create the .env file

Copy `.env.example` from the repo to the Mac Mini and fill in the real
values. The [`.env.example`](../.env.example) at the repo root is the
authoritative annotated reference.

```sh
# From the dev machine
scp .env.example YOUR_USERNAME@<mac-mini-ip>:/opt/hamster-cam/.env

# On the Mac Mini
chmod 600 /opt/hamster-cam/.env
vim /opt/hamster-cam/.env
```

Critical values to have ready:

| Variable | Where to get it |
|---|---|
| `ZYPHR_API_KEY` / `ZYPHR_APP_SECRET` | Zyphr.dev dashboard → Applications → your app → Keys & Secrets |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens, scoped to `Zone:DNS:Edit` on your zone |
| `RTSP_PASSWORD` / `FRIGATE_RTSP_PASSWORD` | Generate with `openssl rand -base64 24`. Mirror to each Pi's `/etc/go2rtc/go2rtc.env`. |
| `MQTT_PASSWORD` | Generate with `openssl rand -base64 24`. Used by Mosquitto, Frigate, and the backend. |
| `PUBLIC_URL` | `https://<CADDY_HOSTNAME>` — required for the live-view WS proxy allowlist. |

For the Docker-compose stack, the correct values for service URLs are:

```sh
MQTT_URL=mqtt://mosquitto:1883
FRIGATE_URL=http://frigate:5000
```

These are Docker DNS names that resolve within the compose network.
They are the correct values for this setup; no host-IP alternatives
are needed.


## Step 6 — Copy infra configs to the Mac Mini

First seed `mac-mini/frigate-config.yml` on the **dev machine** from
the tracked example, since the real file is gitignored:

```sh
# On the dev machine, in the repo root
cp mac-mini/frigate-config.example.yml mac-mini/frigate-config.yml
# Edit the new file — at minimum the WebRTC LAN IP (Step 8.3) and
# the go2rtc stream URLs (Step 8.1). Zones can be drawn later in
# Frigate's web UI (Step 8.5).
```

`deploy.sh` handles config sync for normal updates, but on first setup
you can copy manually:

```sh
# From the dev machine, in the repo root
rsync -av --exclude='frigate-config.example.yml' \
    mac-mini/ YOUR_USERNAME@<mac-mini-ip>:/opt/hamster-cam/
```

The `--exclude` keeps the template off the Mini — only the real
`frigate-config.yml` should live at `/opt/hamster-cam/`.

Every config lands at the **project root** (`/opt/hamster-cam/`),
because that is where `docker-compose.yml`'s relative bind mounts
resolve from. Do **not** place `frigate-config.yml` in a subdirectory —
the compose mount is `./frigate-config.yml:/config/config.yml`, so a
missing or misplaced file causes Docker to create an empty directory in
its place, Frigate finds no config, and cameras boot empty.

The `mosquitto/` directory must contain `mosquitto/config/mosquitto.conf`
before the broker starts — if Docker auto-creates an empty dir, Mosquitto
refuses to start.


## Step 7 — Start Mosquitto

Mosquitto is the MQTT broker; bring it up first because Frigate and the
app both depend on it.

### 7.1 — Create the MQTT passwd file

`mosquitto.conf` has `allow_anonymous false` and references
`password_file /mosquitto/config/passwd`. The passwd file is not in git
and must be created once on the Mac Mini:

```sh
# On the Mac Mini
cd /opt/hamster-cam
set -a; . ./.env; set +a
docker compose run --rm --entrypoint sh mosquitto -c \
  "mosquitto_passwd -b -c /mosquitto/config/passwd \"$MQTT_USERNAME\" \"$MQTT_PASSWORD\" && chmod 600 /mosquitto/config/passwd"

# Verify it landed
ls -la mosquitto/config/passwd   # should be -rw------- owned by you
```

### 7.2 — Start the broker

```sh
docker compose up -d mosquitto
docker compose logs -f mosquitto
```

Verify:

```sh
# MQTT is listening on localhost:1883
ss -tlnp | grep 1883

# Healthcheck should be green within ~10 seconds
docker compose ps mosquitto
```


## Step 8 — Configure and start Frigate

Frigate is configured via `/opt/hamster-cam/frigate-config.yml` (the
compose file mounts it to `/config/config.yml` inside the container).
The repo ships a template that pulls camera credentials from `.env`.

> **The real `frigate-config.yml` is gitignored** (it accumulates
> host-specific values: the Mac Mini's WebRTC LAN IP, zones drawn in
> Frigate's web editor, operator-tuned object masks). The repo ships
> [`mac-mini/frigate-config.example.yml`](../mac-mini/frigate-config.example.yml)
> as the annotated template. If you haven't already, seed it on the
> dev machine before any of the steps below:
>
> ```sh
> cp mac-mini/frigate-config.example.yml mac-mini/frigate-config.yml
> ```
>
> Once it's on the Mini, the **Mini's copy is authoritative** — edit
> it directly with `ssh`/`vim`, or push bulk changes from the dev
> machine with `./deploy.sh --sync-frigate-config` (the remote copy is
> backed up to `frigate-config.yml.bak-<ts>` first).

### 8.1 — Camera configuration

Each camera has a **go2rtc stream name** (the key under `go2rtc.streams`
and `cameras`) and pulls its stream from the corresponding Pi's RTSP URL.

```yaml
go2rtc:
  streams:
    # Stream name is the identifier the app uses everywhere — enter it
    # (or Discover it) in Settings → Cameras as the "Live source" (live_src).
    hamster_cam_1:
      - rtsp://hamster:{FRIGATE_RTSP_PASSWORD}@hamster-cam-1.local:8554/camera

cameras:
  hamster_cam_1:
    ffmpeg:
      inputs:
        # detect + record read the local go2rtc relay over loopback —
        # each Pi is pulled only once over WiFi.
        - path: rtsp://127.0.0.1:8554/hamster_cam_1
          input_args: preset-rtsp-restream
          roles: [detect, record]
    detect:
      width: 1280   # matches the Pi's 720p H264
      height: 720
      fps: 5
```

Confirm the Pi Zeros are streaming H264 (see
[SETUP_PI_ZERO.md](./SETUP_PI_ZERO.md) Step 8) before bringing Frigate
up — on each Pi, `curl -s http://127.0.0.1:1984/api/streams` should
report the producer codec as `h264` with `profile=High`.

### 8.2 — Resolve Pi `.local` names inside Docker

The camera URLs use mDNS names (`hamster-cam-1.local`). The Mac Mini
host resolves these via Avahi, but Docker's internal resolver does not
speak mDNS. Without this step Frigate starts but shows no video because
ffmpeg cannot resolve the hostnames.

Fix: reserve a static IP for each Pi in your router's DHCP settings
(bind to the Pi's MAC address), then add `extra_hosts` to the `frigate`
service in `docker-compose.yml`:

```yaml
extra_hosts:
  - "hamster-cam-1.local:192.168.1.51"   # replace with your reserved IPs
  - "hamster-cam-2.local:192.168.1.52"
```

Find the current IPs on the Mac Mini host (which can resolve mDNS):

```sh
getent hosts hamster-cam-1.local
getent hosts hamster-cam-2.local
```

### 8.3 — Set the WebRTC candidate IP

Open `mac-mini/frigate-config.yml`, find the `go2rtc: webrtc: candidates:`
block, and replace the placeholder IP with the Mac Mini's actual LAN IP.
This is required for WebRTC live view on the LAN; without a correct
candidate IP the player falls back to MSE (still works, not lowest latency).

### 8.4 — Start Frigate

`frigate-config.yml` references `{FRIGATE_RTSP_PASSWORD}`, `{MQTT_USERNAME}`,
and `{MQTT_PASSWORD}`. Compose interpolates these from `.env`, but only if
run from the project directory or with `--env-file`:

```sh
cd /opt/hamster-cam
docker compose --env-file .env up -d frigate
docker compose logs -f frigate
```

Confirm the password reached the container (the most common cause of
black cameras is an empty var):

```sh
docker exec hamster-frigate sh -c 'echo "[$FRIGATE_RTSP_PASSWORD]"'
# Must print the real password; empty [] means .env wasn't loaded.
# A plain restart won't re-read env — recreate with the command above.
```

Frigate's web UI is at `http://<mac-mini-ip>:5000`. All cameras should
be live within a minute or two. The Frigate UI has no auth — it is
published to the LAN only. Never forward port 5000 at your router.

> **Port 5000 conflict (macOS path only):** AirPlay Receiver squats on
> 5000. Disable it via System Settings → General → AirDrop & Handoff →
> turn off "AirPlay Receiver." Ubuntu has nothing on 5000 by default.

### 8.5 — Define zones (these drive the diary)

A **zone** is a named region of a camera frame. When the pet is detected
inside one, the backend's narrator turns it into a diary entry — and the
**zone name decides the activity**. Names are matched (case-insensitively,
as substrings) by `matchKeyword` in `app/server/src/narrator.ts`:

| Zone name (any of these substrings) | Diary activity |
|---|---|
| `wheel` | running on the wheel |
| `food`, `bowl`, `feed` | eating |
| `water`, `drink` | drinking |
| `bathroom`, `potty`, `litter`, `toilet` | bathroom |
| `bed`, `nest`, `sleep`, `rest` | resting |
| `tunnel`, `tube`, `pipe` | in the tunnel |
| `hide`, `cave`, `burrow` | hiding |
| anything else | exploring (still emits a friendly entry) |

So name a zone `wheel`, `food`, `water`, `bathroom`, `bed`, `tunnel`, or
`hide` to get the matching activity; any other name falls through to
"exploring". Zones live per-camera in `frigate-config.yml` under each
camera's `zones:` block.

**Option A — Frigate's web zone editor (easiest for getting the shape right):**

1. Open the Frigate UI on the LAN: `http://<mac-mini-ip>:5000`.
2. Go to **Settings → Mask & Zone editor**, pick the camera, click **Add
   Zone**, and draw a polygon over the cage feature (wheel, bowl, etc.).
3. Name it exactly one of the keywords above (e.g. `wheel`) and **Save** —
   Frigate prints the generated `coordinates` for that zone.
4. Copy those coordinates into the matching camera's `zones:` block in
   **`frigate-config.yml`** (the host copy is authoritative — see "Apply"
   below). Don't rely on Frigate's in-container edit alone; persist it to
   `frigate-config.yml` so a redeploy doesn't lose it.

**Option B — hand-edit `frigate-config.yml`:**

Add a named zone under the camera. `coordinates` is a single comma-
separated list of `x,y` points (≥3) as **fractions of the frame** —
`0,0` is top-left, `1,1` is bottom-right:

```yaml
cameras:
  hamster_cam_1:
    # ...inputs / detect...
    zones:
      wheel:
        coordinates: 0.05,0.10,0.45,0.10,0.45,0.55,0.05,0.55   # a box
      food:
        coordinates: 0.55,0.10,0.95,0.10,0.95,0.45,0.55,0.45
```

**Apply the change.** `frigate-config.yml` is host-authoritative, so back
it up and edit the host copy directly, or push the repo's copy with
`./deploy.sh --sync-frigate-config` (it backs the remote up first). Then
reload Frigate:

```sh
cd /opt/hamster-cam
cp frigate-config.yml "frigate-config.yml.bak-$(date -u +%Y%m%dT%H%M%SZ)"
# ...edit zones...
docker compose restart frigate            # re-reads the config file
```

> A plain `restart` re-reads the config file. If you *also* changed an
> env-substituted value (e.g. `{FRIGATE_RTSP_PASSWORD}`), recreate instead:
> `docker compose up -d --force-recreate frigate`.

**Verify:** in the Frigate UI, trigger motion inside the zone (or watch
the debug view) and confirm the zone highlights; then check the app's
diary shows the matching activity.

### 8.6 — Detection model

Frigate's default model does not recognize "hamster". Two options:

**Quick path:** Track `mouse` or `cat` with a low `min_score` (e.g.
0.30) in `frigate-config.yml`. Works well enough for one stationary cage.

**Better path:** Collect 200–500 snapshots via Frigate's snapshot
feature, label them in Roboflow, train a YOLOv8n model on Roboflow's
free tier, export to OpenVINO IR format, and replace the `model:` block
in `frigate-config.yml`.

Watch the Frigate debug view to confirm detections; tune `min_score`
and zone thresholds until false positives are minimal.


## Step 9 — Bring up Caddy and DDNS

```sh
cd /opt/hamster-cam
docker compose up -d cloudflare-ddns caddy
docker compose logs -f caddy
```

Wait for Caddy to obtain its Let's Encrypt cert via the Cloudflare
DNS-01 challenge. Look for "certificate obtained successfully" in the
logs within ~30 seconds. If it does not appear, double-check that
`CLOUDFLARE_API_TOKEN` has `Zone:DNS:Edit` scope on the correct zone
and that `CADDY_HOSTNAME` matches the A record at Cloudflare.


## Step 10 — Deploy the app

The hamster-app image is **built on the dev machine** — a cross-compiled
linux/amd64 image from the arm64 Apple Silicon laptop — and shipped to
the Mini via SSH. The Mini never builds the image and needs no Node or
pnpm installed.

### 10.1 — One-time: UID alignment

The container runs as the `node` user (uid 1000). The bind-mounted dirs
`./db` and `./storage` must be owned by that same uid:

```sh
# On the Mac Mini
id -u && id -g   # if both are 1000, no chown needed
```

If your uid differs, set `HOST_UID` / `HOST_GID` in `.env` and chown:

```sh
sudo chown -R 1001:1001 /opt/hamster-cam/db     # replace 1001 with your uid
sudo chown -R 1001:1001 /opt/hamster-cam/storage
```

Also confirm the deploy user is in the `docker` group:

```sh
groups YOUR_USERNAME   # must include "docker"
# If not: sudo usermod -aG docker YOUR_USERNAME && newgrp docker
```

### 10.2 — Point deploy.sh at the Mac Mini

In the repo-root `.env` on the **dev machine** (separate from the Mini's
`.env`), set the SSH target:

```sh
MAC_MINI_HOST=project-server   # or the static LAN IP from Step 1
MAC_MINI_USER=YOUR_USERNAME
MAC_MINI_PATH=/opt/hamster-cam
```

If you use a dedicated SSH key, pass it via `SSH_OPTS`:
`SSH_OPTS="-i ~/.ssh/hamster_ed25519" ./deploy.sh`

### 10.3 — First deploy

```sh
# On the dev machine, from the repo root
./deploy.sh
```

What the script does, in order:

1. `docker buildx build --platform linux/amd64 -t hamster-cam/app:local -f app/Dockerfile --load .`
   (The dev machine is arm64; this flag is mandatory for the amd64 Mini.)
2. `docker save hamster-cam/app:local | gzip | ssh $REMOTE 'gunzip | docker load'`
3. Rsyncs infra configs (compose, Caddyfile, mosquitto, fail2ban) to the Mini.
4. `docker compose --env-file .env up -d --remove-orphans` on the Mini.

The first build is slow (several minutes — `better-sqlite3` compiles
a native addon under QEMU emulation for amd64). Subsequent builds are
much faster because Docker caches the layers.

### 10.4 — Subsequent deploys

```sh
./deploy.sh            # rebuild image, ship, compose up

# If only infra configs changed (no app code changes):
./deploy.sh --infra-only   # syncs configs, runs compose up, no image build

# To also push the dev machine's .env (remote copy backed up to .env.bak-<ts>):
./deploy.sh --sync-env
```

### 10.5 — Verify

```sh
# On the Mac Mini
docker compose ps hamster-app           # should be "Up (healthy)"
docker compose logs -f hamster-app      # watch startup + migrations
curl -fsS http://127.0.0.1:3000/health  # backend answers locally
```

Then load the app at its public Cloudflare URL.

> **Rollback footnote.** If the container has a blocking issue,
> a host-side systemd unit is available as an emergency path —
> the service file `app/server/hamster-app.service` is kept in the
> repo. For that path, set `MQTT_URL=mqtt://127.0.0.1:1883` and
> `FRIGATE_URL=http://127.0.0.1:5000` (Docker service names do not
> resolve from the host process). This path is not the normal
> deployment model.


## Step 11 — Bootstrap the first admin

There is no in-app "create admin" form. Bootstrap the first admin once
on the Mac Mini via the CLI inside the running container:

```sh
# On the Mac Mini
cd /opt/hamster-cam
set -a; . .env; set +a
docker compose exec hamster-app node dist/bootstrap.js \
  --email you@example.com \
  --display-name "Dad" \
  --password "$(openssl rand -base64 24)"
```

Record the password somewhere safe. After this, sign in normally via
the login screen, and create every subsequent account (children,
co-admins, etc.) from Settings → Users in the running app.


## Verification checklist

Before declaring the Mac Mini ready, confirm:

- [ ] `ssh YOUR_USERNAME@<mac-mini-ip>` works with key auth (no password prompt)
- [ ] Static DHCP lease reserved for the Mini's MAC address
- [ ] `docker run hello-world` succeeds
- [ ] `vainfo` shows the Intel iHD driver (Linux path only)
- [ ] `/opt/hamster-cam/.env` exists, chmod 600, with real values
- [ ] `docker compose ps` shows mosquitto, frigate, caddy, cloudflare-ddns,
      and hamster-app all `Up (healthy)`
- [ ] Frigate web UI at port 5000 shows all cameras live
- [ ] go2rtc WS endpoint responds 101:
      ```sh
      curl -s -o /dev/null -w '%{http_code}' --http1.1 \
        -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
        -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
        -H 'Sec-WebSocket-Version: 13' \
        'http://127.0.0.1:5000/api/go2rtc/api/ws?src=hamster_cam_1'
      # → 101
      ```
- [ ] Frigate zones are defined for each camera
- [ ] `ss -tlnp` shows Caddy listening on the configured HTTPS port (default 2053)
- [ ] Caddy log shows "certificate obtained successfully"
- [ ] `docker compose ps hamster-app` shows `Up (healthy)`
- [ ] `curl -fsS http://127.0.0.1:3000/health` returns 200
- [ ] Bootstrap admin can sign in at the Cloudflare-proxied URL


## Common issues

- **Frigate restarts in a loop** with "cannot find /dev/dri": OpenVINO
  drivers are not installed or the iGPU is not exposed to the container.
  Re-check Step 3 (`vainfo`) and the `device_cgroup_rules` in
  `mac-mini/docker-compose.yml`.
- **Caddy fails to obtain a cert**: usually a Cloudflare API token scope
  problem. The token needs `Zone:DNS:Edit` on the specific zone, not
  "All zones".
- **Camera streams are black** or show "Cannot open RTSP source": the
  RTSP password in `.env` does not match each Pi's
  `/etc/go2rtc/go2rtc.env`. Test the URL directly with VLC. Also
  confirm `FRIGATE_RTSP_PASSWORD` is non-empty inside the container
  (`docker exec hamster-frigate sh -c 'echo [$FRIGATE_RTSP_PASSWORD]'`).
- **MQTT events not flowing**: confirm Mosquitto's passwd file exists
  and that both Frigate and the backend use the same `MQTT_PASSWORD`.
- **hamster-app container crashes on startup**: check
  `docker compose logs hamster-app` for migration errors or missing
  env vars (especially `WEB_DIST_PATH` and `DATABASE_PATH`).
- **OpenVINO inference slow on 2018 Mini**: the UHD 630 handles two
  cameras at 720p/5fps fine. If overloaded, reduce fps per camera in
  `frigate-config.yml` before adding hardware.
