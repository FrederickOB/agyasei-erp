# syntax=docker/dockerfile:1.7
#
# The API image — also the image for Fly's release_command (db:migrate) and
# the `worker` process (the scheduled-job runner). One image, three commands,
# so the jobs and the migrations can never be a different build from the
# server they serve.
#
#   docker build -f infra/docker/api.Dockerfile --build-arg ERP_BUILD=$(git rev-parse --short HEAD) -t erp-api .
#
# Build context: the repository root (see .dockerignore).
# Base images are pinned by digest; bump them deliberately (Dependabot opens
# the PR), never by a moving tag resolving differently on deploy day.

ARG NODE_IMAGE=node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

# ── build ───────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm CI=true
RUN corepack enable
WORKDIR /repo

# Every workspace manifest, so the frozen lockfile matches the workspace; only
# the API's dependency closure is installed. This layer is cached until a
# manifest or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/money/package.json packages/money/
COPY packages/ops/package.json packages/ops/
COPY packages/sequence/package.json packages/sequence/
COPY packages/sync-drills/package.json packages/sync-drills/
COPY packages/wire-conformance/package.json packages/wire-conformance/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@erp/api..."

COPY packages ./packages
COPY apps/api ./apps/api
# Workspace dependencies that compile (contracts, money, sequence), then the
# bundle: dist/bin/{main,migrate,jobs,ops}.js + dist/migrations/.
RUN pnpm --filter "@erp/api^..." run --if-present build \
 && pnpm --filter @erp/api run build

# ── runtime ─────────────────────────────────────────────────────────────────
# Node and the bundle. No pnpm, no node_modules, no source, no shell tools
# beyond the base image's.
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
ARG ERP_BUILD=unknown
ENV ERP_BUILD=${ERP_BUILD}
USER node
EXPOSE 8080
CMD ["node", "dist/bin/main.js"]
