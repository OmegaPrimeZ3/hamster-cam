# Security Review — 2026-05-19

## Summary

**Pass with findings.** Listen up: the integrated stack from commit `d3637ab` walks the §7.7 checklist with discipline. The Zyphr login proxy keeps tokens server-side, `__Host-session` cookies are correctly attributed, role gating is uniformly enforced via `adminProcedure`, last-admin lockouts are refused, secrets stay out of git history, and the Caddy header block ships the full HSTS/CSP/Permissions-Policy battery. No Critical findings. One **High**: Caddy's reverse-proxy receives requests from Cloudflare but no `trusted_proxies` block is configured, so `{remote_host}` is the Cloudflare edge IP — both the `/auth/*` rate-limit and fail2ban will mis-identify abusers (and at the limit, lock out Cloudflare itself, taking the site down). Five Mediums covering an unauthenticated `/health` info-leak, an SSRF surface in `cameras.testStream`, audit-log rows always written with `target_id = NULL`, unredacted Pino logs, and an over-broad `network_mode: host` on the DDNS container. Fix the High and the SSRF before release; the others can be remediated in Stage 5.

## Findings

### Finding 1 — Caddy lacks `trusted_proxies` for Cloudflare; rate-limit and fail2ban will attribute to the wrong IP

- **Severity:** High
- **Where:** `mac-mini/caddy/Caddyfile:8-24`, `mac-mini/caddy/Caddyfile:77-83`, `mac-mini/caddy/Caddyfile:91-93`, `mac-mini/fail2ban/filter.d/caddy-auth.conf:43`
- **What:** The Caddyfile global options block doesn't declare a `servers { trusted_proxies cloudflare ... }` block (or static `trusted_proxies static <cf-ranges>`). In Caddy 2.7+, `{remote_host}` returns the **direct** peer IP (the Cloudflare edge), and `request.client_ip` in the JSON access log falls back to `remote_ip` when no trusted proxy is declared — i.e. also Cloudflare. The `@auth_paths` rate-limit keys on `{remote_host}`, and `header_up X-Real-IP {remote_host}` forwards the Cloudflare IP to Fastify. The fail2ban filter regex matches `client_ip` and feeds it to `iptables-allports`.
- **Why it matters:** Three concrete consequences from the same root cause:
  1. The 20-events/min `/auth/*` rate-limit applies per Cloudflare edge IP. A real attacker behind Cloudflare looks like the same handful of Anycast IPs every other visitor uses; one attacker burns the budget for the entire household. Conversely, a single misbehaving family member can DOS the whole house's logins.
  2. fail2ban will ban Cloudflare edge IPs at the host's iptables. The first time a child mistypes their password 10 times in 10 minutes, the Mac Mini blackholes one of Cloudflare's edge IPs — Cloudflare retries from a different edge, the next round repeats, and within a few hours the site goes dark from outside (Cloudflare → origin connections are blocked at the firewall).
  3. The backend's request log shows Cloudflare IPs in `req.ip`. Any forensics or backend-side audit IP correlation is useless.
- **Fix:** Add to the Caddyfile global options block:
  ```caddyfile
  servers {
      trusted_proxies cloudflare {
          interval 12h
          timeout 15s
      }
      client_ip_headers CF-Connecting-IP X-Forwarded-For
  }
  ```
  (Requires the `caddy-cloudflare-ip` module in the xcaddy build, or use `trusted_proxies static <ipv4-and-ipv6-cloudflare-ranges>` as a backstop.) Then change `header_up X-Real-IP {remote_host}` to `header_up X-Real-IP {client_ip}` and rebuild the Caddy image. fail2ban filter is already keyed on `client_ip` — once Caddy fills it correctly, the regex starts capturing real client IPs.

### Finding 2 — `cameras.testStream` is an authenticated SSRF; admin can probe internal hosts

- **Severity:** Medium
- **Where:** `app/server/src/frigate.ts:139-168`, `app/server/src/trpc.ts:405-409`
- **What:** `testStream` accepts an arbitrary URL from an admin, parses it, and for `http(s)` schemes issues a `fetch(url, { method: 'HEAD' })` with no `redirect: 'manual'` and no host-allowlist. Default `fetch()` follows redirects, so a 302 to `http://169.254.169.254/...` (AWS-style metadata), `http://[::1]:9200/` (local Elasticsearch), or any RFC1918 / link-local target is silently followed. The agent file's audit list explicitly calls this surface out (*"cameras.testStream admin procedure validates URLs and doesn't follow redirects to internal hosts"*). The implementation does neither.
- **Why it matters:** A compromised admin session (or social-engineered admin) can use the Mac Mini as a confused-deputy port scanner / metadata-endpoint reader for the LAN. Even without a redirect chain, an admin can directly point it at `http://127.0.0.1:5000/api/...` (Frigate internal) or any RFC1918 host. The 3-second timeout returns a `status` number to the caller, giving the attacker enough signal to do a binary port-up/port-down sweep of the LAN from inside the trust boundary.
- **Fix:** Two-line change:
  ```ts
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    // Reject loopback, link-local, RFC1918, and metadata endpoints
    if (isInternalHost(parsed.hostname)) return { ok: false, status: null };
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, redirect: 'manual' });
    return { ok: res.ok, status: res.status };
  }
  ```
  with `isInternalHost` checking for `localhost`, `0.0.0.0`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`. Cameras live on the LAN, but Frigate is the one Frigate-side endpoint the backend talks to; admins testing a stream URL are expected to point at a public-facing camera URL or use `rtsp://` (which short-circuits the fetch path entirely).

### Finding 3 — `/health` is reachable from the public internet

- **Severity:** Medium
- **Where:** `app/server/src/index.ts:91-124`, `mac-mini/caddy/Caddyfile:91-93`
- **What:** `/health` is registered on the Fastify app with no `requireAuth` preHandler. The comment in `index.ts:91` claims it's *"local-only; Caddy rate-limits the path"* — but the Caddyfile only applies `rate_limit` to `@auth_paths path /auth/*`, and the `reverse_proxy host.docker.internal:3000` block proxies every other path including `/health` through to the public listener on `cam.remy-hamster.com`. The endpoint returns `db` status, `storage` writability, and a `disk_free_pct` integer.
- **Why it matters:** PLAN §7.7 hardening checklist explicitly lists the exact set of unauthenticated endpoints: the six `/auth/*` routes. `/health` is not in that set. The information leak is modest (boolean "db ok" + disk-free percentage), but `disk_free_pct` plus repeated polling gives an attacker a side channel: a sudden drop in disk free is observable. More importantly the checklist line *"every Fastify and tRPC route except the documented `/auth/*` set has a `preHandler: requireAuth`"* is violated as written, which makes the whole audit harder to keep clean over time.
- **Fix:** Either (a) gate `/health` behind `requireAuth` and switch external uptime monitoring to authenticate, or (b) restrict the path at Caddy:
  ```caddyfile
  @internal_only {
      path /health
      not remote_ip 127.0.0.1 ::1 10.0.0.0/8 192.168.0.0/16
  }
  respond @internal_only 404
  ```
  Option (b) keeps the local docker healthcheck working without exposing the data outside the LAN.

### Finding 4 — Audit log rows always have `target_id = NULL`; admin actions are unattributable to the row they touched

- **Severity:** Medium
- **Where:** `app/server/src/trpc.ts:88-110` (the `adminProcedure` middleware), `app/server/src/db.ts:808-819`
- **What:** The `adminProcedure` builder writes an audit row after every successful mutation, but the insert hardcodes `target_id: null` and `details: null`. PLAN §5.4 documents the column as *"stringified id of the affected row"* and the schema declares `target_id TEXT`. The Settings → Audit tab displays the JSON `details` blob *"with before/after snapshot for updates"* — that text in the PLAN is a contract that's not being met by the implementation.
- **Why it matters:** When an audit reviewer opens the tab to find out which user was deleted last Tuesday, they see `users.delete` rows attributed to `actor_user_id` but with no indication of *who* was deleted (the row is already gone — that's the whole point of an audit trail). Forensic value of the table is dramatically reduced; the append-only design is sound but the payload is empty.
- **Fix:** In the `adminProcedure` middleware, accept a `target_id` resolver in `meta` (e.g. `meta({ audit: 'users.delete', targetType: 'user', targetIdFrom: (input) => String(input.id) })`) and call it with the procedure input. For mutations that produce a new row (`users.create`, `cameras.create`, `recipients.create`), resolve `target_id` from `result.data.id` after the `await next()` resolves. Populate `details` with a small before/after diff for `update`-shaped procedures.

### Finding 5 — Pino logger is not configured to redact session IDs, refresh tokens, or API keys

- **Severity:** Medium
- **Where:** `app/server/src/index.ts:49`, `app/server/src/auth.ts:93`, `app/server/src/share.ts:19`, `app/server/src/jobs/*.ts`
- **What:** PLAN §7.7 line: *"No password, access_token, refresh_token, session ID, or Zyphr API key ever appears in server logs (scrub at the log layer)."* The Pino instance in `index.ts:49` is constructed with `{ name, level }` only — no `redact` option. The default `pino.stdSerializers.req` skips headers (so the `__Host-session` cookie isn't logged on normal requests) but on a thrown error in any handler that does `req.log.error({ err, req })`, Pino will serialize the full request including `req.headers.cookie`. Similarly any object-shaped log argument that happens to contain a token (e.g. an SDK error attaching its request body) goes to disk verbatim.
- **Why it matters:** Cookie session IDs are session-impersonation tokens. A captured access log with `cookie: __Host-session=<sid>` lets the holder hijack the user until session expiry (30 days default). The exposure surface here is small (no current call site explicitly logs a request body), but the hardening requirement is "scrub at the log layer" — defense-in-depth, not "audit every call site".
- **Fix:** Configure Pino redaction at construction:
  ```ts
  const logger = pino({
    name: 'hamster-app',
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        '*.password', '*.access_token', '*.refresh_token',
        '*.zyphr_refresh_token', 'ZYPHR_API_KEY', 'CLOUDFLARE_API_TOKEN',
      ],
      remove: true,
    },
  });
  ```
  And switch the disk-watch and share modules from their own `pino({...})` instances to a shared logger (or replicate the redact config). The same logger is wired through Fastify's `loggerInstance`, so request/error logs inherit redaction.

### Finding 6 — cloudflare-ddns container uses `network_mode: host` unnecessarily

- **Severity:** Medium
- **Where:** `mac-mini/docker-compose.yml:131-152`
- **What:** The `cloudflare-ddns` service runs with `network_mode: host`. The image's README confirms host-mode is **optional** — required only for the `local` IP provider or for IPv6 without configuring a Docker IPv6 bridge. Our config uses `IP4_PROVIDER=cloudflare.trace` (which makes an outbound HTTPS call to Cloudflare to discover the public IP, works on any bridge network) and `IP6_PROVIDER=none`.
- **Why it matters:** `network_mode: host` bypasses Docker's network namespace isolation. The container has full visibility into every listening socket on the Mac Mini — including the Mosquitto port-bound-to-127.0.0.1 broker (which it could now reach directly), the Caddy admin API on 127.0.0.1:2019, the Fastify app on PORT 3000, and anything else the host has bound to localhost. The container is mitigated by `cap_drop: ALL`, `read_only: true`, `no-new-privileges`, and the image is distroless — a defense-in-depth-stack that's strong, but unnecessary host-namespace exposure widens the blast radius of any future image CVE or supply-chain incident.
- **Fix:** Remove `network_mode: host`. The default bridge network is sufficient for `cloudflare.trace` and `none` IPv6. No other settings need to change.

### Finding 7 — `forgotPassword` introduces a timing oracle for email existence

- **Severity:** Low
- **Where:** `app/server/src/auth.ts:257-275`
- **What:** Handler always returns 204, but the code path differs: if the email exists in the local mirror, it awaits `triggerForgotPassword` (which makes an outbound HTTPS round-trip to Zyphr); if not, it returns 204 immediately. The difference is measurable in milliseconds.
- **Why it matters:** PLAN §5.4 explicitly says *"Always returns 204 regardless of whether the email exists, to avoid enumeration."* The status code matches, but the timing side channel partially defeats the intent. An attacker can determine which of a list of emails has a local mirror by binary timing comparison.
- **Fix:** Either always invoke `triggerForgotPassword` (the function already swallows errors, and Zyphr's own non-enumeration handling is the actual protection), or wrap the conditional branch in a `setTimeout`-equivalent constant-time delay. The simpler patch:
  ```ts
  await triggerForgotPassword(email);  // always call, regardless of local mirror
  reply.code(204).send();
  ```

### Finding 8 — `ZYPHR_FROM_EMAIL` is required by `share.send` but missing from `.env.example` and the README's secrets table

- **Severity:** Low
- **Where:** `app/server/src/share.ts:98-99`, `app/server/src/jobs/disk-watch.ts:114-117`, `app/server/src/config.ts:33`, `.env.example` (entire file), `README.md:97-122`
- **What:** `share.send` throws `Error('ZYPHR_FROM_EMAIL is not configured')` when the env var is missing. `disk-watch.ts:116` logs a warning and skips the alert. The variable is `.optional()` in the config schema, but operationally required for the documented Send-a-Clip flow. Neither `.env.example` nor the README's *"Environment variables at a glance"* table mention it.
- **Why it matters:** Not a security-finding-proper, but the operator deploys, configures the documented .env, and discovers Send-a-Clip is broken only when a child tries to use it. Worse: every share attempt fails with a backend error visible in the response, which is moderately information-leaky about backend internals. PLAN §9 acceptance bullet *"every env var from .env.example shows up in the README table with its purpose"* is a contract this drift violates.
- **Fix:** Add to `.env.example`:
  ```bash
  # Sender address for Zyphr-delivered emails (Send-a-Clip, disk-critical alerts).
  # Must be a domain verified in your Zyphr dashboard. PLAN §5.4 Send-a-Clip.
  ZYPHR_FROM_EMAIL=cam@remy-hamster.com
  ```
  And the matching row in the README table.

### Finding 9 — `index.ts` comment misleads about `/health` rate-limiting

- **Severity:** Info
- **Where:** `app/server/src/index.ts:91`
- **What:** Comment claims *"no auth — local-only; Caddy rate-limits the path"*. Caddy does not rate-limit `/health` (rate-limit is `@auth_paths path /auth/*` only). The comment also says "local-only" but the path is reachable from the internet through the reverse proxy.
- **Why it matters:** Documentation drift makes the audit harder. Next reviewer reads the comment, believes the guard exists, doesn't push for the actual fix.
- **Fix:** Either implement the comment (add `/health` to `@auth_paths` or a sibling rate-limit zone, restrict via remote-IP allowlist), or remove the comment and re-evaluate `/health` per Finding 3.

## Checklist coverage

Walking PLAN §7.7 line by line.

| § | Item | Status | Evidence |
|---|---|---|---|
| 7.7 | TLS 1.2+ only (Caddy default) | **Pass** | `mac-mini/caddy/Caddyfile:29-31` uses `tls { dns cloudflare ... }`; Caddy 2.11's default min TLS version is 1.2. No override. |
| 7.7 | `requireAuth` middleware on every Fastify and tRPC route except documented `/auth/*` and `/login` static asset | **Fail** | `/health` is unauthenticated (`app/server/src/index.ts:92`) — see Finding 3. All tRPC procedures go through `protectedProcedure` or `adminProcedure` (`app/server/src/trpc.ts:294-789`). All non-`/auth/*` REST routes route into tRPC. The only escape is `/health`. |
| 7.7 | `requireAdmin` on every mutating `settings.*`, `cameras.*`, `users.*` (except `changeOwnPassword`) | **Pass** | Verified by direct inspection of `app/server/src/trpc.ts` lines 300, 342, 361, 377, 386, 396, 405, 520, 526, 558, 585, 610. Only non-admin mutation in `users.*` is `changeOwnPassword` at line 623 (protectedProcedure, intentional per PLAN). |
| 7.7 | Local `users` mirror is the authorization gate; valid Zyphr login with no local row → 403 `not_provisioned` | **Pass** | `app/server/src/auth.ts:161-170` — `issueLocalSession` returns null when `db.getUserByEmail` is empty; caller emits `reply.code(403).send({ error: 'not_provisioned' })`. |
| 7.7 | Password/credential payloads only travel over TLS | **Pass** | Browser → Caddy is TLS (port 2053, Cloudflare-issued cert). Backend → Zyphr is `https://api.zyphr.dev/v1` (`app/server/src/zyphr.ts:27-32`, default base URL). |
| 7.7 | Backend always forwards email+password to Zyphr server-side; never browser→Zyphr direct | **Pass** | `app/server/src/auth.ts:146` calls `zyphrLogin({ email, password })` after the body is parsed at our server. No `@zyphr-dev` SDK references in `app/web/**`. |
| 7.7 | Session cookie `__Host-` prefixed, HttpOnly, Secure, SameSite=Lax | **Pass** | `app/server/src/session.ts:31` defines `SESSION_COOKIE = '__Host-session'`. `app/server/src/auth.ts:59-68` sets `httpOnly:true, secure:true, sameSite:'lax', path:'/'` with no Domain attribute — meets `__Host-` prefix requirements. |
| 7.7 | Session IDs are 32 random bytes via `crypto.randomBytes(32).toString('hex')` | **Pass** | `app/server/src/auth.ts:115` — `randomBytes(32).toString('hex')`. Imported from `node:crypto` at line 9. |
| 7.7 | tRPC mutations CSRF-protected (cookie + SameSite + custom header) | **Pass** | `__Host-session` is `SameSite=Lax`, so cross-site POSTs don't carry it. The tRPC `httpBatchLink` sends `Content-Type: application/json` (`app/web/src/trpc.ts:35-40`), triggering a CORS preflight on cross-origin requests. The backend has no `@fastify/cors` registration in `app/server/src/index.ts`, so cross-origin requests fail the preflight unconditionally. Combined defenses meet "cookie + SameSite + header check". |
| 7.7 | `users.create` is atomic (Zyphr first, local insert only on Zyphr 2xx) | **Pass** | `app/server/src/trpc.ts:540-555` — `await registerAccount(...)` precedes `db.createUser(...)`. On any thrown SDK error (including `ZyphrEmailTaken`), the local insert is skipped. |
| 7.7 | No password / access_token / refresh_token / session ID / Zyphr API key in logs | **Fail** | See Finding 5. Pino is constructed without a `redact` option (`app/server/src/index.ts:49`). |
| 7.7 | Bootstrap CLI refuses when `users` is non-empty | **Pass** | `app/server/src/bootstrap.ts:30-32` — `if (db.countUsers() > 0) throw new BootstrapAlreadyInitialized()`. Tested in `app/server/test/users.test.ts` per Stage 2a (see test file listings). |
| 7.7 | Cloudflare orange-cloud proxy (home IP hidden) | **N/A** | Operator-side runtime concern, not in-tree config. The DDNS container's `PROXIED=true` (`mac-mini/docker-compose.yml:144`) is the in-tree corroborator — it sets the proxy flag when creating/updating the DNS record. **Pass** for the in-tree slice. |
| 7.7 | Rate limiting at Caddy targeting `/auth/*` | **Pass with caveat** | `mac-mini/caddy/Caddyfile:76-83` defines `@auth_paths path /auth/*` and a `rate_limit` zone keyed on `{remote_host}` with 20 events / 1 min. **However** the `{remote_host}` keying is broken per Finding 1 — events bucket per Cloudflare edge, not per real client. Mechanism exists; tuning is wrong. |
| 7.7 | fail2ban watching `/var/log/caddy/access.log` for 401/403 spam | **Pass with caveat** | `mac-mini/fail2ban/jail.d/caddy.local:27` logpath, `mac-mini/fail2ban/filter.d/caddy-auth.conf:43` regex matches `client_ip` + `/auth/*` + status 401/403. Filter regex is correct against Caddy's documented JSON format. Volume mount on `mac-mini/docker-compose.yml:117` surfaces the log on the host. **Caveat:** without `trusted_proxies`, `client_ip` is Cloudflare's IP — see Finding 1. |
| 7.7 | SSH keys only, password auth disabled in sshd_config | **N/A** | Host-OS config outside the repo (operator step in `docs/SETUP_MAC_MINI.md`). Not Stage-4 scope. |
| 7.7 | Port 22 NOT forwarded on the router | **N/A** | Operator-side, not in-tree. |
| 7.7 | `unattended-upgrades` enabled on Ubuntu | **N/A** | Operator-side. |
| 7.7 | `.env` with secrets is in `.gitignore` and chmod 600 | **Pass** | `.gitignore:17` covers `.env`, `.gitignore:18-19` cover `.env.local` / `.env.*.local`, `.gitignore:20` retains `.env.example`. chmod 600 is operator-side (documented in README §"Configuration & secrets"). |

Additional in-scope items from the agent file:

| Item | Status | Evidence |
|---|---|---|
| Caddyfile: HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, CSP, COOP/CORP | **Pass** | `mac-mini/caddy/Caddyfile:37-53` — all six headers + CSP present and tight. CSP includes `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`. `media-src` includes `'self' blob:`; `connect-src` includes `'self' https://api.zyphr.dev wss://{host}`. |
| Caddy custom build pulls cloudflare-dns + rate-limit plugins; multi-stage build | **Pass** | `mac-mini/caddy/Dockerfile:8-14` — `FROM caddy:2.11.3-builder AS builder` then `RUN xcaddy build --with github.com/caddy-dns/cloudflare --with github.com/mholt/caddy-ratelimit`, then `FROM caddy:2.11.3` copying only the built binary. Toolchain stays in builder stage. |
| Login response 401 identical for missing-email vs wrong-password | **Pass** | `app/server/src/auth.ts:80-83` — `ZyphrAuthenticationError` always produces `reply.code(401).send({ error: 'invalid_credentials' })`. No branching on email-existence at this layer. The 403 `not_provisioned` only fires *after* Zyphr returned a valid 2xx (i.e. credentials were verified upstream), so it does not leak email-existence on bad-password attempts. |
| Audit log is append-only | **Pass with finding** | No `audit.delete` / `audit.update` procedure exists (`app/server/src/trpc.ts:637-664` only has `audit.list`). The only `DELETE FROM audit_log` is the retention sweep at `app/server/src/db.ts:385` + `app/server/src/jobs/retention.ts:67`, per documented 365-day window. Append-only property holds. **But** see Finding 4 — payload completeness is poor. |
| RTSP: go2rtc has rtsp.username + password; Frigate uses the same credentials via env | **Pass** | `pi-zero/go2rtc.yaml:30-33` declares `rtsp: { listen: ":8554", username: hamster, password: ${RTSP_PASSWORD} }`. `mac-mini/frigate-config.yml:91, 119, 147, 175-179` interpolates `{FRIGATE_RTSP_PASSWORD}`. `.env.example:51-52` sets `FRIGATE_RTSP_PASSWORD=${RTSP_PASSWORD}`. Password ships only as `REPLACE_with_long_random_string` placeholder in `.env.example`. |
| Caddy CSP completeness vs frontend's external references | **Pass** | Frontend imports only same-origin assets (`app/web/index.html`, `app/web/vite.config.ts`). `@fontsource/*` packages bundle fonts as self-hosted JS imports — no `https://fonts.gstatic.com` references. No external `<script>`, `<link>`, or `fetch` to non-`'self'` origins. CSP's `connect-src https://api.zyphr.dev` is dead weight (browser never connects directly), but harmless. |
| No unauthenticated endpoints by accident | **Fail** | `/health` is unauthenticated. See Finding 3. |
| PWA service worker doesn't cache `/auth/*` or `/trpc/*` | **Pass** | `app/web/vite.config.ts:44-66` — explicit `NetworkOnly` handlers for `/auth/*` (GET + POST) and `/trpc/*` (GET + POST). `navigateFallbackDenylist: [/^\/trpc/, /^\/auth/, /^\/snapshots/, /^\/stream/, /^\/api/]` at line 43. |
| PWA manifest start_url reasonable | **Pass** | `app/web/public/manifest.json:5` — `"start_url": "/"`. No tracking query parameters, no privacy-leaky favicon name. |
| `cameras.testStream` validates URLs and doesn't follow redirects to internal hosts | **Fail** | See Finding 2. |
| Stage 2a `.npmrc` `verify-deps-before-run=false` security implications | **Pass** | `.npmrc:1` sets it. The flag disables pnpm's auto-`pnpm install` before commands when the lockfile is out of date; it does **not** disable lockfile verification when an explicit `pnpm install` runs. `pnpm-workspace.yaml:8-11` declares an `onlyBuiltDependencies` allowlist of three packages (`better-sqlite3`, `esbuild`, `msw`), so `approve-builds=auto` is bounded — arbitrary postinstall scripts from transitive deps are NOT auto-approved. No security regression. |
| Stage 2a `favonia/cloudflare-ddns:1.16.2` image sanity check | **Pass** | License: Apache-2.0 with LLVM exceptions (per GitHub README). Distroless: confirmed by upstream README ("scratch + non-root user"). Multi-arch: published for amd64, arm64, armv7. Last release 2026-04-02 (1.16.2), 47 days before this audit — within 12 months. The compose service adds `cap_drop: ALL`, `read_only: true`, `no-new-privileges:true`. **However** see Finding 6 — `network_mode: host` is unnecessary. |
| Stage 2b React Query v4 + `@trpc/react-query` 10.x + `exactOptionalPropertyTypes: false` runtime risk | **Pass** | React Query v4 is still maintained for security patches (Tanstack publishes critical fixes to the v4 line through 2026). The pinned tRPC v10 react-query adapter is the stable companion. `exactOptionalPropertyTypes: false` for the web workspace is a TS-strictness loosening, not a runtime check loosening — produces no extra type-safety holes that surface at runtime in user input handling. No security risk. |
| Secrets in git history | **Pass** | `git log -p \| grep -iE 'password\|secret\|token\|api[_-]?key'` returns only: (a) test fixture password `'hunter2'` (a widely-used placeholder, not a real credential); (b) documentation strings ("password", "API token", etc.); (c) `.env.example` placeholders (`REPLACE_ME`, `REPLACE_with_long_random_string`, `zy_live_REPLACE_ME`). No real keys, no real passwords, no leaked tokens. `.env` is gitignored at `.gitignore:17`. |

## Out-of-band recommendations

Items not on PLAN §7.7's checklist but worth flagging.

- **Constant-time email comparison in `db.getUserByEmail`.** The current `SELECT * FROM users WHERE email = ? COLLATE NOCASE` is short-circuit; combined with Finding 7's timing oracle, a sufficiently determined attacker could enumerate emails via timing. Severity is Info — better-sqlite3 prepared statements with a single string compare are fast enough that the network jitter dwarfs the local-CPU branch difference in practice, but the layered concern with Finding 7 is worth a comment in `auth.ts`.

- **`forgotPassword` validation skip.** `app/server/src/auth.ts:261-267` — on Zod parse failure of the body, the handler still returns 204. That's deliberate non-enumeration, but it also means malformed POSTs aren't logged with `400`-level visibility. Consider logging the parse failure at `info` (without the body, per Finding 5) so abuse patterns stay observable.

- **Backend `req.ip` attribution.** Fastify trusts `X-Forwarded-For` only if `trustProxy: true` is set. The current `Fastify({ loggerInstance })` doesn't set `trustProxy`. Even after fixing Finding 1 (so Caddy sets `X-Real-IP` to the real client), the backend will log `req.ip` as Caddy's container IP unless `trustProxy: '127.0.0.1'` (or the docker bridge) is added. Pair this with the Caddy `trusted_proxies` fix.

- **Session rotation on privilege change.** When `users.update` changes a user's role (admin↔child), existing sessions for that user retain their old context until the user re-logs-in. The `requireAdmin` middleware re-checks the role on every request via `db.getUserById(session.user_id)`, so a demoted admin loses admin powers immediately — but the converse (promoted child gains admin powers without re-login) is unusual but acceptable. Consider invalidating sessions on role change as defense-in-depth: `db.deleteSessionsForUser(input.id)` in the `users.update` mutation handler.

- **`share.send` rate-limit per-recipient as well as per-user.** Current rate-limit is "N sends per user per hour" (`share.ts:40-46`). A child with access to N recipients can fire-and-forget one clip to each — within budget but high-fanout. Severity is Info, mostly a quality-of-life observation for the parent who'll get the bug report.

- **Caddy header `Server` removal.** Already done via `-Server` (Caddyfile:55). Good. Consider also removing `Caddy` from the `Alt-Svc` header (HTTP/3 advertisement) if the operator wants full version hiding.

- **`.gitignore` modification on `main` is uncommitted.** The current working tree has `.gitignore` modified to ignore `docs/PLAN.md`, `docs/EXECUTION.md`, and `.claude/`. This is fine in principle (the planning docs are operator-side, not for the public repo), but the modification has been sitting uncommitted since before Stage 4. Either commit it explicitly (with a clear rationale in the commit message) or revert. The audit deliverable `docs/SECURITY_REVIEW.md` is unaffected — the ignore lines target specific files, not the `docs/` directory.
