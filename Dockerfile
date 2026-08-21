# Shared image for the API, the scheduler, and the workers. All three are the
# same codebase with different entrypoints — see docker-compose.yml `command:`.

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

# ── deps ─────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages/core/package.json      packages/core/
COPY packages/db/package.json        packages/db/
COPY apps/api/package.json           apps/api/
COPY apps/worker/package.json        apps/worker/
COPY apps/scheduler/package.json     apps/scheduler/
RUN npm ci

# ── build ────────────────────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate --schema packages/db/prisma/schema.prisma
# Build ONLY the backend workspaces. `npm run build` at the root would also
# run the SPA's vite build, which needs esbuild's native binary that
# --ignore-scripts deliberately skipped — and which this image never serves
# anyway. The dashboard has its own image (apps/web/Dockerfile).
RUN npm run build -w @djs/core -w @djs/db -w @djs/api -w @djs/worker -w @djs/scheduler

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production

COPY --from=deps  /app/node_modules            ./node_modules
# `prisma generate` writes the client into node_modules/.prisma during the BUILD
# stage, but node_modules above comes from `deps` — which predates it. Without
# this overlay the image starts and dies with "@prisma/client did not initialize
# yet", at runtime, in the container only.
COPY --from=build /app/node_modules/.prisma    ./node_modules/.prisma
COPY --from=build /app/packages/core/dist      ./packages/core/dist
COPY --from=build /app/packages/db/dist        ./packages/db/dist
COPY --from=build /app/packages/db/prisma      ./packages/db/prisma
COPY --from=build /app/packages/db/sql         ./packages/db/sql
COPY --from=build /app/apps/api/dist           ./apps/api/dist
COPY --from=build /app/apps/worker/dist        ./apps/worker/dist
COPY --from=build /app/apps/scheduler/dist     ./apps/scheduler/dist
COPY --from=build /app/package.json            ./package.json
COPY --from=build /app/packages/core/package.json     ./packages/core/package.json
COPY --from=build /app/packages/db/package.json       ./packages/db/package.json
COPY --from=build /app/apps/api/package.json          ./apps/api/package.json
COPY --from=build /app/apps/worker/package.json       ./apps/worker/package.json
COPY --from=build /app/apps/scheduler/package.json    ./apps/scheduler/package.json

# Run unprivileged. `node` (uid 1000) ships with the base image.
USER node

# Workers and the scheduler trap SIGTERM to drain gracefully (ARCHITECTURE.md §15).
# No `npm start` wrapper — npm would swallow the signal and the drain would never run.
STOPSIGNAL SIGTERM

CMD ["node", "apps/api/dist/main.js"]
