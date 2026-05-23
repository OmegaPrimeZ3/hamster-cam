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
# .npmrc carries `approve-builds=auto` and `verify-deps-before-run=false`.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY app/server/package.json ./app/server/
COPY app/web/package.json    ./app/web/

# Install ALL workspace deps (including devDeps — needed for tsup/vite builds).
# --frozen-lockfile: fail fast if the lockfile is out of date.
# --ignore-scripts: skips lifecycle scripts; pnpm v11 blocks on unapproved
#   build scripts. We compile better-sqlite3 explicitly below so we control
#   exactly when and how node-gyp runs.
# COREPACK_ENABLE_STRICT=0 suppresses the pnpm update nag (non-TTY safe).
RUN COREPACK_ENABLE_STRICT=0 pnpm install --frozen-lockfile --ignore-scripts

# Compile better-sqlite3's native addon for the target platform (linux/amd64).
# pnpm v11 silently skips build scripts gated by approve-builds even with rebuild.
# We install node-gyp globally then call it directly so we control the compile.
# node:24-bookworm has python3, g++, and make already installed.
RUN npm install -g node-gyp --silent && \
    cd /repo/node_modules/.pnpm/better-sqlite3@11.3.0/node_modules/better-sqlite3 && \
    node-gyp rebuild && \
    echo "Native addon built:" && \
    ls build/Release/better_sqlite3.node

# Now copy the full source.
COPY tsconfig.base.json ./
COPY app/server/ ./app/server/
COPY app/web/    ./app/web/

# Build the Fastify + tRPC server (tsup) FIRST — output lands in app/server/dist.
# app/web imports AppRouter types from @hamster-cam/server/trpc (resolved to
# app/server/dist/trpc.d.ts), so the server must be compiled before web tsc runs.
RUN pnpm -C app/server build

# Build the React SPA — pnpm -C app/web build runs `tsc --noEmit && vite build`
# so the image build typechecks exactly like CI and the deploy script do.
# If this fails with a type error, fix the type error — do not bypass tsc.
WORKDIR /repo/app/web
RUN COREPACK_ENABLE_STRICT=0 pnpm -C /repo/app/web build
WORKDIR /repo

# -----------------------------------------------------------------------
# Produce a self-contained, prod-only node_modules for the server using
# pnpm's purpose-built deploy command. This creates /prod with a flat
# node_modules that actually resolves at runtime (no pnpm symlink magic).
# --prod excludes devDependencies so the final image ships only runtime deps.
# --ignore-scripts skips native rebuilds; we copy the already-compiled
# better-sqlite3 .node binary in the next step instead.
# -----------------------------------------------------------------------
RUN COREPACK_ENABLE_STRICT=0 pnpm --filter "@hamster-cam/server" deploy --prod --legacy \
    --ignore-scripts /prod

# Restore the amd64 better-sqlite3 native addon compiled above into the
# deployed node_modules. The deploy --ignore-scripts left an empty Release dir.
# We copy the pre-compiled binary (same node-gyp build, same container) so
# the deployed tree is self-contained and correct for linux/amd64.
RUN mkdir -p /prod/node_modules/better-sqlite3/build/Release && \
    cp /repo/node_modules/.pnpm/better-sqlite3@11.3.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
       /prod/node_modules/better-sqlite3/build/Release/better_sqlite3.node

# Verify the amd64 .node binary is present and is the right architecture.
# `file` output must contain "ELF 64-bit LSB" and "x86-64".
RUN file /prod/node_modules/better-sqlite3/build/Release/better_sqlite3.node

# Copy the freshly compiled server bundle into /prod so the deployed tree
# has compiled JS. pnpm deploy copies the package files but not dist/.
RUN cp -r /repo/app/server/dist/. /prod/dist/

# -----------------------------------------------------------------------
# Stage 2: runtime — slim image, non-root user, only what's needed to run.
# -----------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# ffmpeg — required at runtime by three backend features that shell out to it:
# the wheel odometer (optical rotation counting), Send-a-Clip (recording-window
# extraction), and the nightly time-lapse (snapshot stitching). Install as root
# (before the USER switch below); --no-install-recommends keeps it lean.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Run as a non-root user. The default `node` user (uid 1000) is already
# present in node images. We use it rather than creating a new one so the
# uid is predictable and documented (see compose `user:` in docker-compose.yml).
USER node

WORKDIR /app

# Copy compiled server bundle from the deployed tree.
COPY --from=build --chown=node:node /prod/dist       ./dist

# Copy the migrations directory. migrate.ts resolves it at runtime as
# join(__dirname, '..', 'migrations') — from /app/dist/ that is /app/migrations.
COPY --from=build --chown=node:node /repo/app/server/migrations ./migrations

# Copy the prod-only, flattened node_modules produced by `pnpm deploy`.
# Standard flat layout — Node's resolver finds fastify, better-sqlite3, and
# all other server deps directly. No pnpm store symlinks required at runtime.
COPY --from=build --chown=node:node /prod/node_modules ./node_modules

# Copy the built React SPA — served by the Fastify static handler.
# WEB_DIST_PATH env var (set in docker-compose.yml) points to this path.
COPY --from=build --chown=node:node /repo/app/web/dist ./web/dist

# Fastify listen port (also set via env in compose; this documents the default).
EXPOSE 3000

# Liveness check — hits the unauthenticated /health endpoint.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
