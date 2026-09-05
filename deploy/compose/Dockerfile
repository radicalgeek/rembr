# syntax=docker/dockerfile:1

ARG UPSTREAM_IMAGE=pgvector/pgvector:pg16@sha256:a36250871de0833b8757561c72f2477ef1ddd1101afa4e617fb552e0de514c6b
FROM ${UPSTREAM_IMAGE}

LABEL org.opencontainers.image.source="https://github.com/radicalgeek/rembr" \
      org.opencontainers.image.title="rembr-self-host-database" \
      org.opencontainers.image.licenses="MIT AND PostgreSQL"

USER 0:0

RUN --mount=type=bind,source=rembr-pgvector/THIRD_PARTY_NOTICES.md,target=/tmp/THIRD_PARTY_NOTICES.md,ro \
    set -eux; \
    test "$(id -u postgres):$(id -g postgres)" = "999:999"; \
    test -x /usr/local/bin/gosu; \
    rm -f /usr/local/bin/gosu; \
    test ! -e /usr/local/bin/gosu; \
    install -d -o 999 -g 999 -m 2775 /var/run/postgresql /var/lib/postgresql/data; \
    install -d -o 999 -g 999 -m 0555 \
      /docker-entrypoint-initdb.d /opt/rembr-bootstrap /opt/rembr-migrations; \
    install -d -m 0755 /usr/share/doc/rembr-pgvector; \
    install -m 0644 /tmp/THIRD_PARTY_NOTICES.md \
      /usr/share/doc/rembr-pgvector/THIRD_PARTY_NOTICES.md

COPY --chown=999:999 deploy/k8s/02-create-schema.sql \
  /docker-entrypoint-initdb.d/02-create-schema.sql
COPY --chown=999:999 deploy/compose/bootstrap-database.sh \
  /opt/rembr-bootstrap/bootstrap-database.sh
COPY --chown=999:999 deploy/compose/create-app-role.sql \
  deploy/compose/public-baseline-compatibility.sql \
  deploy/compose/auth-security-migration.sql \
  deploy/compose/grant-app-role.sql \
  /opt/rembr-bootstrap/
COPY --chown=999:999 rembr-mcp/src/migrations/ /opt/rembr-migrations/

RUN chmod 0444 /docker-entrypoint-initdb.d/02-create-schema.sql \
      /opt/rembr-bootstrap/create-app-role.sql \
      /opt/rembr-bootstrap/public-baseline-compatibility.sql \
      /opt/rembr-bootstrap/auth-security-migration.sql \
      /opt/rembr-bootstrap/grant-app-role.sql \
    && chmod 0555 /opt/rembr-bootstrap/bootstrap-database.sh \
    && find /opt/rembr-migrations -type d -exec chmod 0555 {} + \
    && find /opt/rembr-migrations -type f -exec chmod 0444 {} +

USER 999:999
