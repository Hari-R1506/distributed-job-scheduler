# The dashboard: build with Vite, serve the static output with nginx.
#
# Built from the repo root (see docker-compose.yml `context: .`) so the
# workspace lockfile resolves.

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/core/package.json      packages/core/
COPY packages/db/package.json        packages/db/
COPY apps/api/package.json           apps/api/
COPY apps/worker/package.json        apps/worker/
COPY apps/scheduler/package.json     apps/scheduler/
COPY apps/web/package.json           apps/web/
# --ignore-scripts skips the native postinstalls the SPA build does not need
# (prisma engines, argon2 — the latter cannot even compile on alpine without a
# toolchain). But esbuild DOES need its postinstall: it downloads the
# platform-specific binary, and without it the build dies with
# "Host version X does not match binary version Y". So rebuild just that one.
RUN npm ci --ignore-scripts && npm rebuild esbuild

COPY apps/web apps/web
COPY tsconfig.base.json ./

# Baked in at BUILD time — Vite inlines env vars into the bundle, so this
# cannot be changed by restarting the container. Left empty by default, which
# makes the SPA call /api/v1 on its own origin and lets nginx proxy it.
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL

WORKDIR /app/apps/web
RUN npm run build

# ── serve ────────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
