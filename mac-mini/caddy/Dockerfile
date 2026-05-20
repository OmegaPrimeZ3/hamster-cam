# Custom Caddy build — base image + three Caddy plugins that the stock image
# doesn't ship: caddy-dns/cloudflare (for DNS-01 ACME against Cloudflare),
# mholt/caddy-ratelimit (for the /auth/* throttle in the Caddyfile), and
# WeidiDeng/caddy-cloudflare-ip (an ip_sources provider that pulls the
# current Cloudflare edge ranges so `trusted_proxies cloudflare` resolves
# {client_ip} to the real visitor instead of the Cloudflare Anycast IP).
#
# The cloudflare-ip module is the canonical community source for this
# integration (referenced from PLAN §7.7 and the Stage-4 security review).
#
# Tag both base images to a specific patch release so a `docker compose build`
# six months from now produces the same binary. Bump deliberately.

FROM caddy:2.11.3-builder AS builder
RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare \
    --with github.com/mholt/caddy-ratelimit \
    --with github.com/WeidiDeng/caddy-cloudflare-ip

FROM caddy:2.11.3
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
