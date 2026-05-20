# remy-hamster

> A weekend-buildable, child-friendly pet camera system with AI activity
> detection and a storybook-style activity diary.

<!-- Hero placeholder — drop a 5-second GIF of the tablet view here once the
     UI is screen-recordable. See PLAN §9.4 for sizing notes. -->
![Hero — tablet view of the camera grid + diary](docs/hero.png)

## The story

I built this for my daughter. She loves Remy, her hamster, and Remy lives
in a cage in a room she's not always in. So we set out to give her a way
to peek in on him from anywhere — running on his wheel, sneaking a
midnight snack, or curled up asleep — and to read a little diary of his
day.

What started as "stick a webcam on a Pi" turned into a full self-hosted
multi-camera AI activity-tracking pet-cam, because that's what happens
when a dad with a Mac Mini and time on his hands gets enthusiastic. This
repo is the entire blueprint: hardware shopping list, configs, code, and
a step-by-step plan that takes a weekend.

If you build one, please send a photo.

## What it does

- Multi-camera live streaming from cheap WiFi-connected Pi Zero rigs
- On-device AI detection (Frigate + OpenVINO) flags activity in zones:
  wheel, food bowl, water, hideaway, etc.
- Renders raw events as a kid-friendly storybook diary:
  *"Remy went for a run on the wheel — 8 min!"*
- Earns playful badges (Night Owl, Marathon Runner, Foodie)
- One-tap snapshot button saves treasured memories
- Self-hosted at a real domain (`cam.remy-hamster.com`) with dynamic
  DNS, TLS, and SSO auth so grandma can watch from her couch
- **Zyphr.dev email/password sign-in with role-based access** — the
  Login form is rendered by our app and matches the kid-friendly
  theme; the backend proxies credentials to Zyphr's `/auth/login`
  API; admins create every account from Settings (calls Zyphr's
  `/auth/register`); child accounts see cameras and the diary but
  can't reach Settings; Zyphr handles password storage, hashing,
  and rate-limiting
- Designed tablet-first, 64px tap targets, read-aloud support

## Who is this for?

- Parents who want to give a kid a magical window into their pet's world
- Tinkerers who like Pi Zeros, Docker Compose, and self-hosted everything
- Pet owners who already enjoy Frigate and want a cuddlier UI on top of it

You don't need to be a hamster owner. The whole UI is themable to any pet
— the onboarding wizard lets you pick a name, emoji, and color palette.

## Hardware shopping list

| Item                              | Qty | Approx. cost |
|-----------------------------------|-----|--------------|
| Raspberry Pi Zero 2 W             | 3   | $15 ea       |
| Arducam IMX462 USB low-light cam  | 3   | $35 ea       |
| 16 GB microSD card                | 3   | $6 ea        |
| USB-A → micro-USB OTG cable       | 3   | $4 ea        |
| 5 V 2.5 A power supply (micro-USB)| 3   | $8 ea        |
| Mac Mini (2018+, Intel)           | 1   | use what you have / ~$300 used |
| Coral USB Accelerator (optional)  | 1   | $60          |
| **Total (excluding Mac Mini)**    |     | **~$200**    |

The Mac Mini is the brain. Any always-on Linux box with an Intel iGPU
(for OpenVINO) or a Coral USB stick will work — a NUC, an old laptop,
even a beefier Raspberry Pi 5 with a Coral.

## Configuration & secrets

Before you bring anything up you'll need to gather a handful of
credentials and pick a few hostnames. Everything the stack reads
comes from a single `.env` file on the Mac Mini at
`/opt/hamster-cam/.env` (chmod 600, owned by the app user). A
fully-commented [`.env.example`](.env.example) lives at the repo
root — `cp .env.example .env` and fill in the placeholders.

### Accounts you need to create

| Service | What you need | Where to get it |
|---|---|---|
| **Zyphr.dev** | An account + an application + a server-side API key (`zy_live_…`) | [zyphr.dev](https://zyphr.dev) → dashboard → API Keys |
| **Cloudflare** | An account + a registered domain on Cloudflare DNS + a scoped API token | [dash.cloudflare.com](https://dash.cloudflare.com) → My Profile → API Tokens → *Create Token* with `Zone : DNS : Edit` scoped to your one zone |

That's the entire external dependency list. No paid SaaS, no third
SMS provider, no separate email host — Zyphr handles password-reset
emails and the share-clip emails through its own messaging API.

### Environment variables at a glance

This table mirrors [`.env.example`](.env.example) line for line; if a
variable shows up here it shows up there and vice versa.

| Variable | Purpose | Notes |
|---|---|---|
| `ZYPHR_API_KEY` | Authenticates the backend against Zyphr's API | Format: `zy_live_…`. Auth endpoints are open at Zyphr; key is still passed by the SDK. |
| `ZYPHR_BASE_URL` | Override the Zyphr API host | *Optional.* Defaults to `https://api.zyphr.dev/v1`. |
| `ZYPHR_FROM_EMAIL` | Sender address for Zyphr-delivered emails | Used by Send-a-Clip and disk-critical alerts. Must be a domain verified in your Zyphr dashboard. |
| `CLOUDFLARE_API_TOKEN` | Updates the A record on IP change + issues Let's Encrypt certs via DNS-01 | Scoped: `Zone : DNS : Edit` on one zone only. |
| `CLOUDFLARE_ZONE` | Your apex domain at Cloudflare | e.g. `remy-hamster.com`. |
| `CLOUDFLARE_SUBDOMAIN` | The subdomain the cam runs at | e.g. `cam` → `cam.remy-hamster.com`. |
| `RTSP_USERNAME` | Locks the go2rtc RTSP listener on each Pi Zero | Defaults to `hamster`. |
| `RTSP_PASSWORD` | The RTSP password | `openssl rand -base64 24`. Mirrored to each Pi at `/etc/go2rtc/go2rtc.env`. |
| `FRIGATE_RTSP_PASSWORD` | What Frigate sends to the Pi Zeros | Must equal `RTSP_PASSWORD`. Defaults to `${RTSP_PASSWORD}` via env-file interpolation. |
| `MQTT_URL` | Where the backend reaches Mosquitto | `mqtt://mosquitto:1883` on the compose network. |
| `MQTT_USERNAME` | Mosquitto username | Used by Frigate **and** the backend. Don't run the broker open. |
| `MQTT_PASSWORD` | Mosquitto password | Stored in the Mosquitto `passwd` file (see Quick start step 4). |
| `FRIGATE_URL` | Where the backend reaches Frigate's REST API | `http://frigate:5000` on the compose network. |
| `PORT` | Fastify listen port | Defaults to `3000`; Caddy reverse-proxies here via `host.docker.internal:3000`. |
| `DATABASE_PATH` | SQLite file location | e.g. `/opt/hamster-cam/db/hamster.db`. The backend runs migrations against this on boot. |
| `STORAGE_PATH` | Where snapshots + nightly time-lapse MP4s land | e.g. `/opt/hamster-cam/storage`. Retention policies (see PLAN §8) live in the `settings` table. |
| `SESSION_TTL_DAYS` | Session cookie lifetime | Defaults to `30`. |
| `CADDY_HTTPS_PORT` | Non-standard HTTPS port at the firewall | Defaults to `2053`. Must be one of Cloudflare's proxied HTTPS ports: `443, 2053, 2083, 2087, 2096, 8443`. |
| `CADDY_EMAIL` | Let's Encrypt account contact | Used for cert expiry notifications. |
| `CADDY_HOSTNAME` | The FQDN you serve at | e.g. `cam.remy-hamster.com`. Must have an A record (proxied/orange-cloud) at Cloudflare. |
| `MAC_MINI_HOST` | SSH target for `deploy.sh` | Hostname or IP. Dev-machine-side. |
| `MAC_MINI_USER` | SSH user for `deploy.sh` | Defaults to `hamster`. |
| `MAC_MINI_PATH` | Remote install root | Defaults to `/opt/hamster-cam`. |
| `TZ` | Container timezone | IANA name, e.g. `America/Los_Angeles`. Defaults to `Etc/UTC`. |

### Per-Pi-Zero secrets

Each Pi also needs a tiny env file at `/etc/go2rtc/go2rtc.env`
(chmod 600, root-owned) containing only the RTSP password:

```sh
RTSP_PASSWORD=<same value as the Mac Mini's .env>
```

The shipped `go2rtc.service` references it via `EnvironmentFile=`,
so go2rtc reads the password at boot without it ever appearing on
a command line or in `/proc`.

### What's NOT in `.env`

- **Admin account credentials.** The first admin is created via the
  bootstrap CLI (`pnpm hamster bootstrap-admin --email … --password …`)
  on the Mac Mini, then every subsequent account is admin-created
  from Settings → Users in the running app. No default password is
  ever baked into the deployment.
- **Pet name, camera URLs, theme.** Stored in the SQLite `settings`
  and `cameras` tables — the admin configures them through the UI
  during onboarding. They aren't environment concerns.

> **Never commit `.env`.** The repo's root `.gitignore` lists it.
> Always commit changes to `.env.example` so contributors can see
> what's expected.

## Architecture

```
[Cage room]                          [Office rack]
                                      ┌──────────────────────────────┐
3× IMX462 USB cam ──┐                │  Mac Mini (Ubuntu Server)    │
                    ├─→ Pi Zero 2W ──┤  ├── Frigate (Docker)        │
3× IMX462 USB cam ──┤  (go2rtc)      │  │   └── go2rtc inside       │
                    ├─→ Pi Zero 2W ──┤  │   └── OpenVINO inference  │
3× IMX462 USB cam ──┘  (go2rtc)     WiFi│  ├── Mosquitto MQTT        │
                                      │  ├── App backend (Fastify)   │
                                      │  │   ├── SQLite             │
                                      │  │   └── MQTT subscriber    │
                                      │  └── App frontend (React)   │
                                      │      served by backend       │
                                      └──────────────────────────────┘
                                                   ↑
                                              Daughter's tablet
                                              over the open internet
                                              (DDNS + Caddy + auth)
```

## Quick start

Full build instructions live in [`docs/PLAN.md`](docs/PLAN.md) — eight
phases, ~4 hours spread across an evening or two. The TL;DR:

1. Flash Ubuntu Server onto the Mac Mini, install Docker
2. Bring up Mosquitto + Frigate via Docker Compose
3. Flash and configure three Pi Zero 2 Ws as RTSP camera servers
4. Point Frigate at the cameras, define zones (wheel, food, water)
5. `pnpm install && ./deploy.sh` from your dev machine
6. Set up dynamic DNS + Caddy + auth, forward your non-standard
   HTTPS port at the router (`CADDY_HTTPS_PORT`, default `2053`,
   TCP **and** UDP for HTTP/3). Add a Cloudflare Origin Rule that
   maps edge `:443` → origin `:2053` so visitors keep using the
   clean URL with no port suffix.
7. Open the URL on a tablet, run the onboarding wizard, done

## Run locally for UI/UX review

For poking the UI without provisioning Pis, Frigate, or a real Zyphr tenant.
One command from the repo root runs both halves in parallel with prefixed
output (`@hamster-cam/server` / `@hamster-cam/web`):

```sh
pnpm install
pnpm dev
```

If you'd rather drive the workspaces independently (e.g. restart just the
backend), use two terminals: `pnpm -F server dev` and `pnpm -F web dev`.

Open <http://localhost:5181> and sign in:

- **Email:** `dev@hamster.local`
- **Password:** `hunterhunter`

The Today feed lands populated with wheel / food / water / bathroom /
transition / resting / exploring entries so every diary card variant
renders on first load.

State persists at `<repo>/.dev/` (SQLite + storage); `rm -rf .dev` resets
to factory defaults.

**Ports.** Backend defaults to **5180** (deliberately off the crowded 3000
range so multiple Node projects can run in parallel); web defaults to
**5181**. Both halves read the same env vars — set them once and `pnpm dev`
propagates them to both children:

```sh
HC_BACKEND_PORT=5274 HC_WEB_PORT=5174 pnpm dev
```

**Other overrides** (all optional): `HC_DEV_EMAIL`, `HC_DEV_PASSWORD`,
`HC_DEV_DISPLAY_NAME`, `HC_DEV_PET_NAME`, `HC_DEV_SANDBOX`,
`DATABASE_PATH`, `STORAGE_PATH`.

**What's missing vs. production.** No MQTT (so no live diary updates from
Frigate events), no real camera streams (the seeded cameras have placeholder
RTSP URLs), no real Zyphr (the in-process stub accepts the seeded password
only). For end-to-end auth/network testing against your real Zyphr tenant,
use `pnpm -F server dev:raw` with your own `.env`.

## Tech stack

- **Edge:** Raspberry Pi Zero 2 W + go2rtc (RTSP server, WebRTC handoff)
- **Brain:** Frigate (NVR + object detection, OpenVINO accelerated)
- **Messaging:** Mosquitto MQTT (Frigate's event bus)
- **App backend:** Fastify + tRPC + better-sqlite3 + MQTT subscriber
- **App frontend:** Vite + React + TypeScript + Framer Motion + Radix UI
- **Transport:** Cloudflare DDNS + Caddy reverse proxy with Let's
  Encrypt TLS on a non-standard port (SNI-routed for multi-site
  hosting)
- **Auth:** [Zyphr.dev](https://zyphr.dev) via the official
  [`@zyphr-dev/node-sdk`](https://www.npmjs.com/package/@zyphr-dev/node-sdk)
  (`zyphr.auth.login.loginEndUser`,
  `zyphr.auth.registration.registerEndUser`,
  `zyphr.auth.passwordReset.forgotPassword`); our own Login form (no
  Zyphr-hosted page); opaque server-side sessions in SQLite with
  HttpOnly `__Host-session` cookie; two roles (`admin` / `child`)
  enforced server-side; admins provision every account from
  Settings → Users
- **Host OS:** Ubuntu Server 24.04 LTS on a Mac Mini

## Customization

Not a hamster person? Change the pet emoji and palette in the onboarding
wizard. Add or remove cameras at any time from Settings → Cameras.
Tweak the narrative templates in `app/server/src/narratives.ts` to match
your pet's vibe — we've shipped defaults for hamsters, rabbits, cats,
dogs, parrots, lizards, fish, and turtles.

## Contributing

PRs welcome, especially:

- Additional pet-themed narrative packs (bunny, hedgehog, gecko, …)
- New badges
- Hardware variant guides (Raspberry Pi 5, NUC, Coral-only setups)
- Translations of the diary templates

See [`CONTRIBUTING.md`](CONTRIBUTING.md) (coming in v0.2) for the
basics.

## Authentication & accounts

The Login form is **rendered by our app** and matches the rest of the
kid-friendly UI — no redirect to a third-party hosted page. Submitting
the form POSTs `{ email, password }` to our backend, which proxies to
[**Zyphr.dev**](https://zyphr.dev)'s `POST /auth/login` API. Zyphr
handles the password storage, hashing, and rate-limiting; our backend
handles authorization (role checks against a local mirror) and issues an
opaque HttpOnly session cookie.

**Two roles** live in the app's local mirror:

- **`admin`** — full access. Manages cameras, pet settings, and every
  account (create, trigger password reset, delete) from a Users tab in
  the Settings drawer. Account creation calls Zyphr's `/auth/register`;
  password reset triggers `/auth/password/forgot`.
- **`child`** — view-only. Sees cameras, the diary, badges, and snapshots.
  **No Settings, no gear icon, no Users tab.** Password changes are
  admin-driven (via the email reset flow).

**No public sign-up.** New accounts are admin-created from inside the
app. The very first admin is created with a one-time CLI command on the
Mac Mini (`pnpm hamster bootstrap-admin --email … --display-name … --password …`)
so a default password is never baked into the image.

Integration uses the official
[`@zyphr-dev/node-sdk`](https://www.npmjs.com/package/@zyphr-dev/node-sdk)
on the backend, so we don't hand-roll HTTP plumbing —
`zyphr.auth.login.loginEndUser`,
`zyphr.auth.registration.registerEndUser`,
`zyphr.auth.passwordReset.forgotPassword`, etc. See **Phase 7.6** in
[`docs/PLAN.md`](docs/PLAN.md) for the endpoint-to-SDK-method table,
error-handling pattern (`ZyphrAuthenticationError`,
`ZyphrRateLimitError`, …), role enforcement, and the deliberate
limitations (no admin-set password, no admin-delete at Zyphr) inherent
to Zyphr's user-centric API.

## Acknowledgments

This project stands on the shoulders of giants:

- [**Frigate**](https://frigate.video) — the NVR doing all the heavy
  lifting
- [**go2rtc**](https://github.com/AlexxIT/go2rtc) — the magic that turns
  $35 USB cameras into low-latency WebRTC streams
- [**Zyphr.dev**](https://zyphr.dev) — email/password auth-as-a-service
  via a clean REST API, so we render our own Login UI but never store a
  single password ourselves
- [**Caddy**](https://caddyserver.com) — automatic TLS that just works
- [**t2linux**](https://wiki.t2linux.org) — getting Ubuntu onto an Intel
  Mac Mini's T2 chip is solved because of these heroes

And of course Remy, the hamster who unknowingly volunteered for QA.

## License

[MIT](LICENSE) © 2026 Aaron Coppock — go forth and build pet cams.
