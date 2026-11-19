# syntax=docker/dockerfile:1.7
#
# The sync service: the upstream PowerSync open-edition image, PINNED BY
# DIGEST, with the production config and THE SYNC RULES baked in.
#
# Why baked rather than mounted: the sync rules are the tenant isolation
# boundary (03 §3.2). Baking them means the rules a machine runs are exactly
# the rules in the image that was reviewed, built and deployed — versioned and
# rolled back WITH the service (09 §9.1, Rule 9.3-D), never edited in place on
# a volume. A rules change is an image build and a deploy, on purpose.
#
#   docker build -f infra/docker/powersync.Dockerfile -t erp-powersync .
#
# Credentials are NOT here: the config reads PS_* environment variables, set
# as Fly secrets (docs/production-runbook.md).
#
# Upgrading PowerSync: change the digest (and the tag in the comment), build,
# deploy to staging first. Rolling the service back may re-key buckets and
# cost every device a re-sync (§9.8 Case B) — it is a decision, not a reflex.

# journeyapps/powersync-service:1.24.0 — the version the dev stack runs.
FROM journeyapps/powersync-service@sha256:0fc9f65e693c07f1206007acddb87141402c09ef20589e29a0dfe20d57ce80b6

COPY --chown=901:901 infra/fly/powersync/config.yaml /config/config.yaml
COPY --chown=901:901 infra/powersync/sync_rules.yaml /config/sync_rules.yaml

ENV POWERSYNC_CONFIG_PATH=/config/config.yaml \
    NODE_OPTIONS=--max-old-space-size=1536

# The upstream image already runs as an unprivileged user (uid 901); say so
# explicitly so a future base change cannot silently make it root.
USER 901
EXPOSE 8080
CMD ["start", "-r", "unified"]
