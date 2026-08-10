#!/usr/bin/env bash

set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${DB_APP_PASSWORD:?DB_APP_PASSWORD is required}"

# Hex keeps the psql-variable hand-off unambiguous and prevents SQL/meta-command
# injection. Generate with: openssl rand -hex 32
if [[ ! "$DB_APP_PASSWORD" =~ ^[A-Fa-f0-9]{64,}$ ]]; then
  printf 'error: DB_APP_PASSWORD must contain at least 64 hexadecimal characters\n' >&2
  exit 2
fi
if [[ "$DB_APP_PASSWORD" == "$PGPASSWORD" ]]; then
  printf 'error: DB_APP_PASSWORD must be independent from POSTGRES_PASSWORD\n' >&2
  exit 2
fi

for bootstrap_sql in \
  create-app-role.sql \
  public-baseline-compatibility.sql \
  auth-security-migration.sql \
  grant-app-role.sql
do
  if [[ ! -f "/opt/rembr-bootstrap/$bootstrap_sql" \
     || ! -r "/opt/rembr-bootstrap/$bootstrap_sql" ]]; then
    printf 'error: required bootstrap SQL is missing or unreadable: %s\n' \
      "$bootstrap_sql" >&2
    exit 1
  fi
done

printf 'Ensuring required PostgreSQL extensions are installed...\n'
psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 --single-transaction <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
DO $extensions$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') OR
     NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'uuid-ossp')
  THEN
    RAISE EXCEPTION 'required vector and uuid-ossp extensions are unavailable';
  END IF;
END
$extensions$;
SQL

printf 'Creating or updating the non-owner application role...\n'
{
  printf '\\set app_password %s\n' "$DB_APP_PASSWORD"
  sed -n '1,$p' /opt/rembr-bootstrap/create-app-role.sql
} | psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 --single-transaction

printf 'Applying public baseline compatibility objects...\n'
psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 --single-transaction \
  --file=/opt/rembr-bootstrap/public-baseline-compatibility.sql

printf 'Applying idempotent MCP database migrations...\n'
MIGRATIONS=(
  001-auto-optimization-tables.sql
  002-pii-detection.sql
  003-file-storage.sql
  004-snapshot-immutability.sql
  005-encrypt-stripe-customer-ids.sql
  006-vector-index-tuning.sql
  007-embedding-model-consistency.sql
  008-api-key-security.sql
  009-stripe-id-protection.sql
  010-contextpilot-schema.sql
  011-plan-regeneration-schema.sql
  012-task-management-schema.sql
  012-task-handoff-schema.sql
  013-vector-search-adaptive-tuning.sql
  014-security-events-table.sql
  015-tenant-plan-limits.sql
  016-acceptance-criteria-schema.sql
  017-audit-logs-mcp-columns.sql
  006-audit-tamper-resistance.sql
  017-compaction-schedules.sql
  018-context-checkpoints-table.sql
  019-context-budgets-table.sql
  020-engagement-events-table.sql
  021_purge_plaintext_oauth_tokens.sql
  024-agentic-features-schema.sql
  025-agentic-runtime-followups.sql
  026-mcp-stateless-protocol.sql
  027-memory-maintenance-jobs.sql
  028-repair-vector-indexes.sql
  029-memory-evolution-jobs.sql
)

for filename in "${MIGRATIONS[@]}"; do
  migration="/opt/rembr-migrations/$filename"
  if [[ ! -f "$migration" || ! -r "$migration" ]]; then
    printf 'error: required MCP migration is missing or unreadable: %s\n' "$filename" >&2
    exit 1
  fi
  printf '  %s\n' "$filename"
  psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 --single-transaction --file="$migration"
done

AUTH_SECURITY_MIGRATION=/opt/rembr-bootstrap/auth-security-migration.sql
if [[ ! -f "$AUTH_SECURITY_MIGRATION" || ! -r "$AUTH_SECURITY_MIGRATION" ]]; then
  printf 'error: required self-host authentication migration is missing or unreadable\n' >&2
  exit 1
fi
printf 'Applying idempotent self-host authentication migration...\n'
psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 \
  --file="$AUTH_SECURITY_MIGRATION"

SECURITY_MIGRATION=/opt/rembr-migrations/030-security-boundaries.sql
if [[ ! -f "$SECURITY_MIGRATION" || ! -r "$SECURITY_MIGRATION" ]]; then
  printf 'error: required MCP security migration is missing or unreadable: 030-security-boundaries.sql\n' >&2
  exit 1
fi
printf 'Applying MCP security boundary migration...\n'
psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 --single-transaction \
  --file="$SECURITY_MIGRATION"

printf 'Applying least-privilege application grants...\n'
psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 \
  --single-transaction --file=/opt/rembr-bootstrap/grant-app-role.sql

printf 'Database bootstrap and application-role verification completed.\n'
