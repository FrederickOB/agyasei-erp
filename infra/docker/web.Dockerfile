# syntax=docker/dockerfile:1.7
#
# The PWA: a static Vite build served by unprivileged nginx with the cache
# headers an offline-first service worker needs (infra/docker/web/).
#
#   docker build -f infra/docker/web.Dockerfile \
#     --build-arg VITE_API_URL=https://api.example \
#     --build-arg VITE_POWERSYNC_URL=https://sync.example \
#     --build-arg BUILD_ID=$(git rev-parse --short HEAD) -t erp-web .
#
# The two URLs are BUILD-TIME (Vite inlines them). A dev bearer token is
# never baked in: the build refuses if VITE_API_TOKEN is set, because a token
# in a public bundle is a credential handed to everyone who opens the page.

ARG NODE_IMAGE=node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0

# ── build ───────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm CI=true
RUN corepack enable
WORKDIR /repo
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
    pnpm install --frozen-lockfile --filter "@erp/web..."

COPY packages ./packages
COPY apps/web ./apps/web

ARG VITE_API_URL
ARG VITE_POWERSYNC_URL
ARG VITE_API_TOKEN=""
ARG BUILD_ID=unknown
RUN if [ -n "$VITE_API_TOKEN" ]; then \
      echo "refusing: VITE_API_TOKEN must never be baked into a production bundle" >&2; exit 1; \
    fi \
 && if [ -z "$VITE_API_URL" ] || [ -z "$VITE_POWERSYNC_URL" ]; then \
      echo "refusing: VITE_API_URL and VITE_POWERSYNC_URL are required build args" >&2; exit 1; \
    fi
RUN pnpm --filter "@erp/web^..." run --if-present build \
 && VITE_API_URL="$VITE_API_URL" VITE_POWERSYNC_URL="$VITE_POWERSYNC_URL" BUILD_ID="$BUILD_ID" \
    pnpm --filter @erp/web run build \
 && rm -f apps/web/dist/release.json \
 && find apps/web/dist -name '*.map' -delete

# ── serve ───────────────────────────────────────────────────────────────────
FROM ${NGINX_IMAGE}
# nginx's entrypoint renders /etc/nginx/templates/*.template into conf.d with
# envsubst at start: the CSP origins and the release gate come from the
# environment, so one image serves any environment.
COPY infra/docker/web/default.conf.template /etc/nginx/templates/default.conf.template
COPY infra/docker/web/security-headers.inc.template /etc/nginx/templates/security-headers.inc.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
ARG BUILD_ID=unknown
# /release.json (the §8.11 version gate) names this image's build by default.
# Set RELEASE_BUILD_ID to hold the fleet on the build it already runs.
ENV BUILD_ID=${BUILD_ID} \
    RELEASE_BUILD_ID=${BUILD_ID} \
    RELEASE_MIN_CLIENT_SCHEMA=1 \
    RELEASE_MAX_CLIENT_SCHEMA=1 \
    CSP_CONNECT_SRC="'self'"
# Unprivileged by construction (uid 101), listening on 8080.
EXPOSE 8080
