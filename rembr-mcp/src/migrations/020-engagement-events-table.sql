-- =============================================================================
-- Migration 020: Engagement Events Table (Growth Engine)
-- Unified intake log for social mentions, support emails, feedback, usage signals.
-- =============================================================================
--
-- Source: growth analytics implementation notes
-- Used by the growth intelligence layer to classify and route engagement
-- signals (feature requests, praise, issues) from all external channels.
-- =============================================================================

CREATE TABLE IF NOT EXISTS engagement_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source metadata
  source              VARCHAR(30)    NOT NULL,
                      -- contact_form | email | moltbook | discord | reddit
                      -- twitter | linkedin | github | in_app | usage_log
  source_url          TEXT,
  source_id           VARCHAR(200),  -- platform-specific ID for deduplication
  source_platform     VARCHAR(50),   -- moltbook, discord, reddit, etc.

  -- Author
  author_handle       VARCHAR(200),
  author_name         VARCHAR(200),
  author_email        VARCHAR(200),
  author_tenant_id    UUID,          -- matched to Rembr user (no FK to keep portable)
  author_is_customer  BOOLEAN        NOT NULL DEFAULT FALSE,

  -- Content
  content             TEXT           NOT NULL,
  content_snippet     TEXT,          -- first 200 chars for previews
  metadata            JSONB,         -- platform-specific fields

  -- Intelligence classification (populated by LLM classifier)
  sentiment           VARCHAR(10),   -- positive | neutral | negative
  sentiment_score     FLOAT,         -- -1.0 to 1.0
  urgency             VARCHAR(10),   -- low | medium | high | critical
  intents             JSONB,         -- [{intent: "feature_request", confidence: 0.92}, ...]
  requires_response   BOOLEAN,
  response_priority   INT,           -- 1-5
  suggested_actions   JSONB,         -- [{action: "create_ticket", params: {...}}, ...]

  -- Routing & lifecycle
  status              VARCHAR(20)    NOT NULL DEFAULT 'new',
                      -- new | routed | responded | resolved | archived
  routed_to           JSONB,         -- [{destination: "plane", ref: "...", routed_at: "..."}, ...]
  response_drafted_at TIMESTAMPTZ,
  response_sent_at    TIMESTAMPTZ,
  response_content    TEXT,
  resolved_at         TIMESTAMPTZ,

  -- Engagement metrics (social mentions)
  engagement_likes    INT            NOT NULL DEFAULT 0,
  engagement_replies  INT            NOT NULL DEFAULT 0,
  engagement_shares   INT            NOT NULL DEFAULT 0,

  -- Timestamps
  created_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_engagement_events_source
  ON engagement_events (source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_engagement_events_sentiment
  ON engagement_events (sentiment)
  WHERE sentiment IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_engagement_events_status
  ON engagement_events (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_engagement_events_intents
  ON engagement_events USING GIN (intents)
  WHERE intents IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_engagement_events_customer
  ON engagement_events (author_is_customer, created_at DESC)
  WHERE author_is_customer = TRUE;

CREATE INDEX IF NOT EXISTS idx_engagement_events_priority
  ON engagement_events (response_priority, requires_response)
  WHERE requires_response = TRUE;

-- ─── updated_at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_engagement_events_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_engagement_events_updated_at ON engagement_events;
CREATE TRIGGER trg_engagement_events_updated_at
  BEFORE UPDATE ON engagement_events
  FOR EACH ROW EXECUTE FUNCTION update_engagement_events_updated_at();

-- ─── Comment ──────────────────────────────────────────────────────────────────

COMMENT ON TABLE engagement_events IS
  'Growth engine: unified intake for social mentions, support emails, feedback, usage signals. '
  'Classification by LLM intelligence layer. Routes to Plane tickets / support / marketing.';
