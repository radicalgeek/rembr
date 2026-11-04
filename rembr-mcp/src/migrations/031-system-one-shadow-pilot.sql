-- TypeSafe System One relationship shadow pilot.
--
-- This migration is deliberately inert:
--   * rembr_shadow is created NOLOGIN;
--   * no tenant/project allowlist rows are inserted;
--   * capture and provider gates default to false;
--   * the shadow role has no direct table access, including memories and
--     memory_relationships;
--   * memory content is available only through a bounded SECURITY DEFINER
--     function after both database gates are enabled for one exact pair.

DO $shadow_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rembr_shadow') THEN
    CREATE ROLE rembr_shadow NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOBYPASSRLS;
  END IF;
  ALTER ROLE rembr_shadow NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOINHERIT NOBYPASSRLS;
END
$shadow_role$;

DO $shadow_connect$
DECLARE
  grant_statement TEXT;
BEGIN
  SELECT format('GRANT CONNECT ON DATABASE %I TO rembr_shadow', current_database())
    INTO grant_statement;
  EXECUTE grant_statement;
END
$shadow_connect$;
GRANT USAGE ON SCHEMA public TO rembr_shadow;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, rembr_shadow;

CREATE TABLE IF NOT EXISTS relationship_shadow_allowlist (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cohort VARCHAR(20) NOT NULL CHECK (cohort IN ('controlled', 'live')),
  capture_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  provider_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  max_total_requests INTEGER NOT NULL DEFAULT 300
    CHECK (max_total_requests BETWEEN 1 AND 5000),
  max_total_input_tokens BIGINT NOT NULL DEFAULT 250000
    CHECK (max_total_input_tokens BETWEEN 1 AND 3000000),
  max_total_cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0.10
    CHECK (max_total_cost_usd > 0 AND max_total_cost_usd <= 5.00),
  max_content_chars INTEGER NOT NULL DEFAULT 16000
    CHECK (max_content_chars BETWEEN 1 AND 16000),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, project_id),
  CHECK (NOT provider_enabled OR capture_enabled)
);

CREATE TABLE IF NOT EXISTS relationship_shadow_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  question_set VARCHAR(128) NOT NULL,
  state_envelope VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'succeeded', 'failed', 'skipped', 'cancelled')),
  priority SMALLINT NOT NULL DEFAULT 100,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 4 CHECK (max_attempts BETWEEN 1 AND 4),
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  leased_until TIMESTAMPTZ,
  lease_owner VARCHAR(128),
  local_similarity DOUBLE PRECISION NOT NULL CHECK (local_similarity BETWEEN 0 AND 1),
  local_relationship_type VARCHAR(32)
    CHECK (local_relationship_type IS NULL OR local_relationship_type IN
      ('supports', 'refines', 'supersedes', 'relates_to', 'contradicts')),
  local_confidence DOUBLE PRECISION
    CHECK (local_confidence IS NULL OR local_confidence BETWEEN 0 AND 1),
  local_selected_for_write BOOLEAN NOT NULL,
  local_decision_reason VARCHAR(32) NOT NULL CHECK (local_decision_reason IN
    ('selected', 'below_similarity', 'below_confidence', 'not_top_eight')),
  sampling_stratum VARCHAR(40) NOT NULL CHECK (sampling_stratum IN
    ('local_write', 'local_skip', 'near_similarity_threshold',
     'temporal_replacement', 'lexical_overlap', 'other')),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  last_error_class VARCHAR(80),
  CHECK (source_memory_id <> target_memory_id),
  UNIQUE (
    tenant_id, project_id, source_memory_id, target_memory_id,
    question_set, state_envelope
  )
);

CREATE INDEX IF NOT EXISTS idx_relationship_shadow_queue_claim
  ON relationship_shadow_queue (tenant_id, project_id, status, available_at, priority, captured_at)
  WHERE status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS relationship_shadow_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id UUID NOT NULL REFERENCES relationship_shadow_queue(id) ON DELETE CASCADE,
  run_id UUID NOT NULL,
  repeat_index SMALLINT NOT NULL DEFAULT 0 CHECK (repeat_index BETWEEN 0 AND 3),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider VARCHAR(64) NOT NULL,
  requested_model VARCHAR(64) NOT NULL,
  returned_model VARCHAR(64) NOT NULL,
  question_set VARCHAR(128) NOT NULL,
  state_envelope VARCHAR(64) NOT NULL,
  predicted_relationship VARCHAR(32) NOT NULL CHECK (predicted_relationship IN
    ('supports', 'refines', 'supersedes', 'relates_to', 'unrelated')),
  probabilities JSONB NOT NULL,
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  accepted_by_gate BOOLEAN NOT NULL,
  raw_content_sha256 CHAR(64) NOT NULL CHECK (raw_content_sha256 ~ '^[0-9a-f]{64}$'),
  cleaned_content_sha256 CHAR(64) NOT NULL CHECK (cleaned_content_sha256 ~ '^[0-9a-f]{64}$'),
  pii_scan_passed BOOLEAN NOT NULL,
  secret_scan_passed BOOLEAN NOT NULL,
  skip_reason VARCHAR(120),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  request_attempts SMALLINT NOT NULL CHECK (request_attempts BETWEEN 1 AND 4),
  http_result_class VARCHAR(32) NOT NULL,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  estimated_cost_usd NUMERIC(12, 8) NOT NULL CHECK (estimated_cost_usd >= 0),
  requested_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  human_label VARCHAR(32) CHECK (human_label IS NULL OR human_label IN
    ('supports', 'refines', 'supersedes', 'relates_to', 'unrelated',
     'ambiguous', 'candidate_invalid')),
  reviewer UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  adjudication_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (queue_id, run_id, repeat_index),
  CHECK (pg_column_size(probabilities) <= 8192),
  CHECK (completed_at >= requested_at)
);

CREATE INDEX IF NOT EXISTS idx_relationship_shadow_predictions_scope
  ON relationship_shadow_predictions (tenant_id, project_id, created_at DESC);

ALTER TABLE relationship_shadow_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_shadow_allowlist FORCE ROW LEVEL SECURITY;
ALTER TABLE relationship_shadow_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_shadow_queue FORCE ROW LEVEL SECURITY;
ALTER TABLE relationship_shadow_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_shadow_predictions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS relationship_shadow_queue_app_read ON relationship_shadow_queue;
CREATE POLICY relationship_shadow_queue_app_read
  ON relationship_shadow_queue FOR SELECT TO rembr_app
  USING (tenant_id::text = current_setting('app.current_tenant', TRUE));

DROP POLICY IF EXISTS relationship_shadow_predictions_app_read ON relationship_shadow_predictions;
CREATE POLICY relationship_shadow_predictions_app_read
  ON relationship_shadow_predictions FOR SELECT TO rembr_app
  USING (tenant_id::text = current_setting('app.current_tenant', TRUE));

CREATE OR REPLACE FUNCTION rembr_capture_relationship_shadow_candidate(
  p_tenant_id UUID,
  p_project_id UUID,
  p_source_memory_id UUID,
  p_target_memory_id UUID,
  p_question_set TEXT,
  p_state_envelope TEXT,
  p_local_similarity DOUBLE PRECISION,
  p_local_relationship_type TEXT,
  p_local_confidence DOUBLE PRECISION,
  p_local_selected_for_write BOOLEAN,
  p_local_decision_reason TEXT,
  p_sampling_stratum TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $capture$
DECLARE
  v_limit INTEGER;
  v_id UUID;
BEGIN
  IF p_source_memory_id = p_target_memory_id
     OR length(p_question_set) NOT BETWEEN 1 AND 128
     OR length(p_state_envelope) NOT BETWEEN 1 AND 64
     OR p_local_similarity NOT BETWEEN 0 AND 1
     OR p_local_decision_reason NOT IN
       ('selected', 'below_similarity', 'below_confidence', 'not_top_eight')
     OR p_sampling_stratum NOT IN
       ('local_write', 'local_skip', 'near_similarity_threshold',
        'temporal_replacement', 'lexical_overlap', 'other') THEN
    RAISE EXCEPTION 'invalid relationship shadow candidate';
  END IF;

  SELECT allowlist.max_total_requests
    INTO v_limit
  FROM public.relationship_shadow_allowlist allowlist
  JOIN public.projects project
    ON project.id = allowlist.project_id
   AND project.tenant_id = allowlist.tenant_id
  WHERE allowlist.tenant_id = p_tenant_id
    AND allowlist.project_id = p_project_id
    AND allowlist.capture_enabled
  FOR UPDATE OF allowlist;

  IF v_limit IS NULL THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.memories source_memory
    JOIN public.memories target_memory
      ON target_memory.id = p_target_memory_id
     AND target_memory.tenant_id = p_tenant_id
     AND target_memory.project_id = p_project_id
    WHERE source_memory.id = p_source_memory_id
      AND source_memory.tenant_id = p_tenant_id
      AND source_memory.project_id = p_project_id
  ) THEN
    RAISE EXCEPTION 'relationship shadow candidate is outside the allowlisted scope';
  END IF;

  SELECT queue.id INTO v_id
  FROM public.relationship_shadow_queue queue
  WHERE queue.tenant_id = p_tenant_id
    AND queue.project_id = p_project_id
    AND queue.source_memory_id = p_source_memory_id
    AND queue.target_memory_id = p_target_memory_id
    AND queue.question_set = p_question_set
    AND queue.state_envelope = p_state_envelope;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  IF (SELECT count(*) FROM public.relationship_shadow_queue queue
      WHERE queue.tenant_id = p_tenant_id AND queue.project_id = p_project_id) >= v_limit THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.relationship_shadow_queue (
    tenant_id, project_id, source_memory_id, target_memory_id,
    question_set, state_envelope, local_similarity,
    local_relationship_type, local_confidence, local_selected_for_write,
    local_decision_reason, sampling_stratum
  ) VALUES (
    p_tenant_id, p_project_id, p_source_memory_id, p_target_memory_id,
    p_question_set, p_state_envelope, p_local_similarity,
    p_local_relationship_type, p_local_confidence, p_local_selected_for_write,
    p_local_decision_reason, p_sampling_stratum
  )
  ON CONFLICT (
    tenant_id, project_id, source_memory_id, target_memory_id,
    question_set, state_envelope
  ) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT queue.id INTO v_id
    FROM public.relationship_shadow_queue queue
    WHERE queue.tenant_id = p_tenant_id
      AND queue.project_id = p_project_id
      AND queue.source_memory_id = p_source_memory_id
      AND queue.target_memory_id = p_target_memory_id
      AND queue.question_set = p_question_set
      AND queue.state_envelope = p_state_envelope;
  END IF;
  RETURN v_id;
END
$capture$;

CREATE OR REPLACE FUNCTION rembr_shadow_claim_relationship_candidates(
  p_tenant_id UUID,
  p_project_id UUID,
  p_worker_id TEXT,
  p_limit INTEGER DEFAULT 2,
  p_lease_seconds INTEGER DEFAULT 30
) RETURNS TABLE (
  id UUID,
  source_memory_id UUID,
  target_memory_id UUID,
  question_set VARCHAR,
  state_envelope VARCHAR,
  local_similarity DOUBLE PRECISION,
  local_relationship_type VARCHAR,
  local_confidence DOUBLE PRECISION,
  local_selected_for_write BOOLEAN,
  local_decision_reason VARCHAR,
  sampling_stratum VARCHAR,
  attempt_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $claim$
BEGIN
  IF length(p_worker_id) NOT BETWEEN 1 AND 128
     OR p_limit NOT BETWEEN 1 AND 50
     OR p_lease_seconds NOT BETWEEN 5 AND 900 THEN
    RAISE EXCEPTION 'invalid relationship shadow lease request';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.relationship_shadow_allowlist allowlist
    WHERE allowlist.tenant_id = p_tenant_id
      AND allowlist.project_id = p_project_id
      AND allowlist.capture_enabled
      AND allowlist.provider_enabled
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH claimable AS (
    SELECT queue.id
    FROM public.relationship_shadow_queue queue
    WHERE queue.tenant_id = p_tenant_id
      AND queue.project_id = p_project_id
      AND queue.status IN ('pending', 'failed')
      AND queue.available_at <= CURRENT_TIMESTAMP
      AND queue.attempt_count < queue.max_attempts
    ORDER BY queue.priority ASC, queue.captured_at ASC, queue.id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public.relationship_shadow_queue queue
  SET status = 'leased',
      lease_owner = p_worker_id,
      leased_until = CURRENT_TIMESTAMP + make_interval(secs => p_lease_seconds),
      attempt_count = queue.attempt_count + 1,
      last_error_class = NULL
  FROM claimable
  WHERE queue.id = claimable.id
  RETURNING queue.id, queue.source_memory_id, queue.target_memory_id,
    queue.question_set, queue.state_envelope, queue.local_similarity,
    queue.local_relationship_type, queue.local_confidence,
    queue.local_selected_for_write, queue.local_decision_reason,
    queue.sampling_stratum, queue.attempt_count;
END
$claim$;

CREATE OR REPLACE FUNCTION rembr_shadow_load_relationship_pair(
  p_queue_id UUID,
  p_tenant_id UUID,
  p_project_id UUID,
  p_worker_id TEXT
) RETURNS TABLE (
  source_content TEXT,
  target_content TEXT,
  source_metadata JSONB,
  target_metadata JSONB
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $load$
  SELECT
    left(source_memory.content, allowlist.max_content_chars),
    left(target_memory.content, allowlist.max_content_chars),
    source_memory.metadata,
    target_memory.metadata
  FROM public.relationship_shadow_queue queue
  JOIN public.relationship_shadow_allowlist allowlist
    ON allowlist.tenant_id = queue.tenant_id
   AND allowlist.project_id = queue.project_id
   AND allowlist.capture_enabled
   AND allowlist.provider_enabled
  JOIN public.memories source_memory
    ON source_memory.id = queue.source_memory_id
   AND source_memory.tenant_id = queue.tenant_id
   AND source_memory.project_id = queue.project_id
  JOIN public.memories target_memory
    ON target_memory.id = queue.target_memory_id
   AND target_memory.tenant_id = queue.tenant_id
   AND target_memory.project_id = queue.project_id
  WHERE queue.id = p_queue_id
    AND queue.tenant_id = p_tenant_id
    AND queue.project_id = p_project_id
    AND queue.status = 'leased'
    AND queue.lease_owner = p_worker_id
    AND queue.leased_until > CURRENT_TIMESTAMP
    AND lower(COALESCE(source_memory.metadata->>'external_processing_allowed', 'false')) = 'true'
    AND lower(COALESCE(target_memory.metadata->>'external_processing_allowed', 'false')) = 'true'
    AND source_memory.pii_detected IS NOT TRUE
    AND target_memory.pii_detected IS NOT TRUE
$load$;

-- 032 replaces this with a different return type, so a rerun must drop it first.
DROP FUNCTION IF EXISTS rembr_shadow_get_relationship_budget(UUID, UUID);
CREATE OR REPLACE FUNCTION rembr_shadow_get_relationship_budget(
  p_tenant_id UUID,
  p_project_id UUID
) RETURNS TABLE (
  provider_enabled BOOLEAN,
  remaining_requests BIGINT,
  remaining_input_tokens BIGINT,
  remaining_cost_usd NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $budget$
  SELECT
    allowlist.capture_enabled AND allowlist.provider_enabled,
    GREATEST(allowlist.max_total_requests - count(prediction.id), 0),
    GREATEST(allowlist.max_total_input_tokens - COALESCE(sum(prediction.input_tokens), 0), 0),
    GREATEST(allowlist.max_total_cost_usd - COALESCE(sum(prediction.estimated_cost_usd), 0), 0)
  FROM public.relationship_shadow_allowlist allowlist
  LEFT JOIN public.relationship_shadow_predictions prediction
    ON prediction.tenant_id = allowlist.tenant_id
   AND prediction.project_id = allowlist.project_id
  WHERE allowlist.tenant_id = p_tenant_id
    AND allowlist.project_id = p_project_id
  GROUP BY allowlist.capture_enabled, allowlist.provider_enabled,
    allowlist.max_total_requests, allowlist.max_total_input_tokens,
    allowlist.max_total_cost_usd
$budget$;

CREATE OR REPLACE FUNCTION rembr_shadow_complete_relationship_prediction(
  p_queue_id UUID,
  p_run_id UUID,
  p_repeat_index SMALLINT,
  p_tenant_id UUID,
  p_project_id UUID,
  p_worker_id TEXT,
  p_provider TEXT,
  p_requested_model TEXT,
  p_returned_model TEXT,
  p_predicted_relationship TEXT,
  p_probabilities JSONB,
  p_confidence DOUBLE PRECISION,
  p_accepted_by_gate BOOLEAN,
  p_raw_content_sha256 TEXT,
  p_cleaned_content_sha256 TEXT,
  p_duration_ms INTEGER,
  p_request_attempts SMALLINT,
  p_http_result_class TEXT,
  p_input_tokens INTEGER,
  p_output_tokens INTEGER,
  p_estimated_cost_usd NUMERIC,
  p_requested_at TIMESTAMPTZ,
  p_completed_at TIMESTAMPTZ
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $complete$
DECLARE
  v_prediction_id UUID;
  v_question_set VARCHAR(128);
  v_state_envelope VARCHAR(64);
  v_max_requests INTEGER;
  v_max_tokens BIGINT;
  v_max_cost NUMERIC;
  v_used_requests BIGINT;
  v_used_tokens BIGINT;
  v_used_cost NUMERIC;
BEGIN
  IF p_predicted_relationship NOT IN
       ('supports', 'refines', 'supersedes', 'relates_to', 'unrelated')
     OR p_confidence NOT BETWEEN 0 AND 1
     OR p_raw_content_sha256 !~ '^[0-9a-f]{64}$'
     OR p_cleaned_content_sha256 !~ '^[0-9a-f]{64}$'
     OR pg_column_size(p_probabilities) > 8192 THEN
    RAISE EXCEPTION 'invalid relationship shadow prediction';
  END IF;

  SELECT allowlist.max_total_requests, allowlist.max_total_input_tokens,
         allowlist.max_total_cost_usd
    INTO v_max_requests, v_max_tokens, v_max_cost
  FROM public.relationship_shadow_allowlist allowlist
  WHERE allowlist.tenant_id = p_tenant_id
    AND allowlist.project_id = p_project_id
    AND allowlist.capture_enabled
    AND allowlist.provider_enabled
  FOR UPDATE;
  IF v_max_requests IS NULL THEN
    RAISE EXCEPTION 'relationship shadow provider gate is disabled';
  END IF;

  SELECT count(*), COALESCE(sum(prediction.input_tokens), 0),
         COALESCE(sum(prediction.estimated_cost_usd), 0)
    INTO v_used_requests, v_used_tokens, v_used_cost
  FROM public.relationship_shadow_predictions prediction
  WHERE prediction.tenant_id = p_tenant_id
    AND prediction.project_id = p_project_id;
  IF v_used_requests + 1 > v_max_requests
     OR v_used_tokens + p_input_tokens > v_max_tokens
     OR v_used_cost + p_estimated_cost_usd > v_max_cost THEN
    RAISE EXCEPTION 'relationship shadow budget exhausted';
  END IF;

  SELECT queue.question_set, queue.state_envelope
    INTO v_question_set, v_state_envelope
  FROM public.relationship_shadow_queue queue
  WHERE queue.id = p_queue_id
    AND queue.tenant_id = p_tenant_id
    AND queue.project_id = p_project_id
    AND queue.status = 'leased'
    AND queue.lease_owner = p_worker_id
    AND queue.leased_until > CURRENT_TIMESTAMP
  FOR UPDATE;
  IF v_question_set IS NULL THEN
    RAISE EXCEPTION 'relationship shadow lease is invalid or expired';
  END IF;

  INSERT INTO public.relationship_shadow_predictions (
    queue_id, run_id, repeat_index, tenant_id, project_id, provider,
    requested_model, returned_model, question_set, state_envelope,
    predicted_relationship, probabilities, confidence, accepted_by_gate,
    raw_content_sha256, cleaned_content_sha256, pii_scan_passed,
    secret_scan_passed, duration_ms, request_attempts, http_result_class,
    input_tokens, output_tokens, estimated_cost_usd, requested_at, completed_at
  ) VALUES (
    p_queue_id, p_run_id, p_repeat_index, p_tenant_id, p_project_id, p_provider,
    p_requested_model, p_returned_model, v_question_set, v_state_envelope,
    p_predicted_relationship, p_probabilities, p_confidence, p_accepted_by_gate,
    p_raw_content_sha256, p_cleaned_content_sha256, TRUE, TRUE,
    p_duration_ms, p_request_attempts, p_http_result_class,
    p_input_tokens, p_output_tokens, p_estimated_cost_usd,
    p_requested_at, p_completed_at
  )
  RETURNING id INTO v_prediction_id;

  UPDATE public.relationship_shadow_queue
  SET status = 'succeeded', completed_at = CURRENT_TIMESTAMP,
      leased_until = NULL, lease_owner = NULL, last_error_class = NULL
  WHERE id = p_queue_id;

  RETURN v_prediction_id;
END
$complete$;

CREATE OR REPLACE FUNCTION rembr_shadow_fail_relationship_candidate(
  p_queue_id UUID,
  p_tenant_id UUID,
  p_project_id UUID,
  p_worker_id TEXT,
  p_terminal BOOLEAN,
  p_error_class TEXT,
  p_retry_delay_seconds INTEGER DEFAULT 30
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fail$
DECLARE
  v_updated INTEGER;
BEGIN
  IF length(p_error_class) NOT BETWEEN 1 AND 80
     OR p_retry_delay_seconds NOT BETWEEN 0 AND 3600 THEN
    RAISE EXCEPTION 'invalid relationship shadow failure record';
  END IF;
  UPDATE public.relationship_shadow_queue queue
  SET status = CASE
        WHEN p_terminal OR queue.attempt_count >= queue.max_attempts THEN 'skipped'
        ELSE 'failed'
      END,
      available_at = CURRENT_TIMESTAMP + make_interval(secs => p_retry_delay_seconds),
      completed_at = CASE
        WHEN p_terminal OR queue.attempt_count >= queue.max_attempts THEN CURRENT_TIMESTAMP
        ELSE NULL
      END,
      leased_until = NULL,
      lease_owner = NULL,
      last_error_class = left(p_error_class, 80)
  WHERE queue.id = p_queue_id
    AND queue.tenant_id = p_tenant_id
    AND queue.project_id = p_project_id
    AND queue.status = 'leased'
    AND queue.lease_owner = p_worker_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END
$fail$;

REVOKE ALL ON TABLE relationship_shadow_allowlist,
  relationship_shadow_queue, relationship_shadow_predictions
  FROM PUBLIC, rembr_app, rembr_shadow;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM rembr_shadow;
GRANT SELECT ON TABLE relationship_shadow_queue,
  relationship_shadow_predictions TO rembr_app;

REVOKE ALL ON FUNCTION rembr_capture_relationship_shadow_candidate(
  UUID, UUID, UUID, UUID, TEXT, TEXT, DOUBLE PRECISION, TEXT,
  DOUBLE PRECISION, BOOLEAN, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rembr_capture_relationship_shadow_candidate(
  UUID, UUID, UUID, UUID, TEXT, TEXT, DOUBLE PRECISION, TEXT,
  DOUBLE PRECISION, BOOLEAN, TEXT, TEXT
) TO rembr_app;

REVOKE ALL ON FUNCTION rembr_shadow_claim_relationship_candidates(
  UUID, UUID, TEXT, INTEGER, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION rembr_shadow_load_relationship_pair(
  UUID, UUID, UUID, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION rembr_shadow_get_relationship_budget(
  UUID, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION rembr_shadow_complete_relationship_prediction(
  UUID, UUID, SMALLINT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  JSONB, DOUBLE PRECISION, BOOLEAN, TEXT, TEXT, INTEGER, SMALLINT,
  TEXT, INTEGER, INTEGER, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION rembr_shadow_fail_relationship_candidate(
  UUID, UUID, UUID, TEXT, BOOLEAN, TEXT, INTEGER
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION rembr_shadow_claim_relationship_candidates(
  UUID, UUID, TEXT, INTEGER, INTEGER
) TO rembr_shadow;
GRANT EXECUTE ON FUNCTION rembr_shadow_load_relationship_pair(
  UUID, UUID, UUID, TEXT
) TO rembr_shadow;
GRANT EXECUTE ON FUNCTION rembr_shadow_get_relationship_budget(
  UUID, UUID
) TO rembr_shadow;
GRANT EXECUTE ON FUNCTION rembr_shadow_complete_relationship_prediction(
  UUID, UUID, SMALLINT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  JSONB, DOUBLE PRECISION, BOOLEAN, TEXT, TEXT, INTEGER, SMALLINT,
  TEXT, INTEGER, INTEGER, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ
) TO rembr_shadow;
GRANT EXECUTE ON FUNCTION rembr_shadow_fail_relationship_candidate(
  UUID, UUID, UUID, TEXT, BOOLEAN, TEXT, INTEGER
) TO rembr_shadow;

DO $shadow_privilege_assertions$
BEGIN
  IF has_table_privilege('rembr_shadow', 'public.memories', 'SELECT')
     OR has_table_privilege('rembr_shadow', 'public.memory_relationships', 'SELECT')
     OR has_table_privilege('rembr_shadow', 'public.memory_relationships', 'INSERT')
     OR has_table_privilege('rembr_shadow', 'public.memory_relationships', 'UPDATE')
     OR has_table_privilege('rembr_shadow', 'public.memory_relationships', 'DELETE')
     OR has_table_privilege('rembr_shadow', 'public.relationship_shadow_queue', 'SELECT')
     OR has_table_privilege('rembr_shadow', 'public.relationship_shadow_predictions', 'INSERT') THEN
    RAISE EXCEPTION 'rembr_shadow retained forbidden direct table privileges';
  END IF;
  IF has_schema_privilege('rembr_shadow', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'rembr_shadow can create objects in public';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'rembr_shadow'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'rembr_shadow role attributes are unsafe';
  END IF;
END
$shadow_privilege_assertions$;
