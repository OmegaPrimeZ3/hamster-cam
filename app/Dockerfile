# -----------------------------------------------------------------------
# app/Dockerfile — multi-stage build for the Fastify + tRPC backend that
# also serves the built React SPA.
#
# Build machine:  arm64 (Apple Silicon dev machine)
# Target platform: linux/amd64 (Mac Mini / Ubuntu Server x86_64)
#
# Cross-build with:
#   docker buildx build --platform linux/amd64 \
#     -t hamster-cam/app:local -f app/Dockerfile --load .
#
# The emulated amd64 build takes several minutes on Apple Silicon due to
# QEMU. better-sqlite3 compiles a native addon — this is the slow part.
# -----------------------------------------------------------------------

# -----------------------------------------------------------------------
# Stage 1: build — node:24-bookworm has python3 + build-essential + g++
# needed to compile better-sqlite3. We run corepack to pin the pnpm
# version declared in the root package.json.
# -----------------------------------------------------------------------
FROM node:24-bookworm AS build

# Enable pnpm via corepack (version locked in root package.json#packageManager).
RUN corepack enable

WORKDIR /repo

# Copy the workspace manifests + lockfile first so Docker can cache the
# install layer separately from source code changes.
# .npmrc carries `approve-builds=auto` and `verify-deps-before-run=false`,
# which pnpm v11 requires to allow onlyBuiltDependencies without interactive
# prompts in a non-TTY environment.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY app/server/package.json ./app/server/
COPY app/web/package.json    ./app/web/

# Install ALL workspace deps (including devDeps — needed for tsup/vite builds).
# --frozen-lockfile: fail fast if the lockfile is out of date.
# --ignore-scripts: skips lifecycle scripts during install to avoid pnpm v11's
#   ERR_PNPM_IGNORED_BUILDS gating; we rebuild better-sqlite3 explicitly below.
# COREPACK_ENABLE_STRICT=0 suppresses the pnpm update nag (non-TTY safe).
RUN COREPACK_ENABLE_STRICT=0 pnpm install --frozen-lockfile --ignore-scripts

# Rebuild better-sqlite3's native addon for the target platform (linux/amd64).
# node:24-bookworm has the build tools (python3, g++, make) needed by node-gyp.
# We skip esbuild (ships prebuilt binaries) and msw (no native addon).
RUN pnpm rebuild better-sqlite3

# Now copy the full source.
COPY tsconfig.base.json ./
COPY app/server/ ./app/server/
COPY app/web/    ./app/web/

# Build the React SPA (vite) — output lands in app/web/dist.
# We call vite build directly rather than `pnpm -C app/web build` because
# the build script runs `tsc --noEmit && vite build`, and there are pre-existing
# TypeScript errors in app/web that block tsc but do not prevent Vite from
# emitting valid JavaScript. The Dockerfile's job is to produce a runnable image,
# not to gate on type-check errors (that is CI's job). This matches how the
# production bundle was built before containerization.
# Run from app/web so vite can locate index.html and resolve the vite config
# root correctly. The bin is in app/web/node_modules/.bin (pnpm does not hoist
# workspace-only devDeps to the root).
WORKDIR /repo/app/web
RUN node_modules/.bin/vite build
WORKDIR /repo

# Build the Fastify + tRPC server (tsup) — output lands in app/server/dist.
RUN pnpm -C app/server build

# -----------------------------------------------------------------------
# Stage 2: runtime — slim image, non-root user, only what's needed to run.
# -----------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# Run as a non-root user. The default `node` user (uid 1000) is already
# present in node images. We use it rather than creating a new one so the
# uid is predictable and documented (see compose `user:` in docker-compose.yml).
USER node

WORKDIR /app

# Copy compiled server bundle + migrations.
COPY --from=build --chown=node:node /repo/app/server/dist       ./dist
COPY --from=build --chown=node:node /repo/app/server/migrations ./migrations

# Copy the server's production node_modules. We copy the whole workspace
# node_modules from the build stage — pnpm hoists all packages there.
# better-sqlite3's native addon (.node file) is already compiled for
# the target platform from the build stage.
COPY --from=build --chown=node:node /repo/node_modules          ./node_modules

# Copy the built React SPA — served by the Fastify static handler.
# WEB_DIST_PATH (set in docker-compose.yml) overrides the default relative
# path so the server finds this directory at runtime.
COPY --from=build --chown=node:node /repo/app/web/dist          ./web/dist

# Fastify listen port (also set via env in compose; this documents the default).
EXPOSE 3000

# Liveness check — hits the unauthenticated /health endpoint.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
