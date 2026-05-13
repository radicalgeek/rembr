-- =============================================================================
-- Migration 008: Stripe Customer ID — DB-Level PCI Protection
-- REM-247: Stripe Customer ID stored in plaintext in tenants table
-- =============================================================================
--
-- BACKGROUND
-- ----------
-- The `tenants.stripe_customer_id` column stores Stripe's customer identifiers
-- (format: `cus_xxxxxxxxxxxx`).  Although not technically a PAN or CVV, Stripe
-- customer IDs are PCI-adjacent: a compromised DB row reveals a direct link
-- between a tenant and a Stripe billing record, enabling account takeover via
-- Stripe's API if combined with the Stripe secret key.
--
-- APPLICATION-LAYER ENCRYPTION (already deployed — REM-255)
-- ----------------------------------------------------------
-- The `rembr-ui` service encrypts/decrypts `stripe_customer_id` at the
-- application layer using authenticated encryption with `STRIPE_ENCRYPTION_KEY`
-- (see migration 005 and rembr-ui/src/lib/crypto.ts).
--
-- This migration adds DB-level safety rails:
-- 1. A CHECK constraint that rejects plaintext Stripe customer IDs
--    (values matching the `cus_` prefix pattern).
-- 2. A trigger that logs an audit event if a plaintext ID somehow bypasses
--    the application layer.
-- 3. A monitoring function to detect any remaining plaintext values.
--
-- IMPORTANT: Run application-layer encryption migration FIRST (migration 005 /
-- the Node.js script in rembr-ui/scripts/migrate-stripe-encryption.ts).
-- This migration will fail on any row that still contains a plaintext `cus_`
-- value in `stripe_customer_id`.
-- =============================================================================

-- 1. Verify no plaintext IDs remain before adding the constraint.
--    This will produce an error if any plaintext values are present,
--    preventing the CHECK constraint from being added to a broken state.
DO $$
DECLARE
  plaintext_count INT;
BEGIN
  SELECT COUNT(*)
    INTO plaintext_count
  FROM tenants
  WHERE stripe_customer_id IS NOT NULL
    AND stripe_customer_id LIKE 'cus_%';

  IF plaintext_count > 0 THEN
    RAISE EXCEPTION
      'Migration 008 blocked: % tenant(s) have plaintext stripe_customer_id values (matching cus_*). '
      'Run the encryption migration script first: rembr-ui/scripts/migrate-stripe-encryption.ts',
      plaintext_count;
  END IF;
END $$;

-- 2. Add CHECK constraint to reject future plaintext Stripe customer IDs.
ALTER TABLE tenants
  ADD CONSTRAINT chk_stripe_customer_id_not_plaintext
  CHECK (
    stripe_customer_id IS NULL
    OR stripe_customer_id NOT LIKE 'cus_%'
  );

COMMENT ON CONSTRAINT chk_stripe_customer_id_not_plaintext ON tenants IS
  'Prevents plaintext Stripe customer IDs (cus_xxx format) from being stored. '
  'Values must be encrypted at the application layer before DB write. '
  'See rembr-ui/src/lib/crypto.ts — encryptStripeCustomerId().';

-- 3. Audit trigger: log any attempt to write a plaintext Stripe customer ID.
--    This fires BEFORE the CHECK constraint so we get a detailed audit trail.
CREATE OR REPLACE FUNCTION trg_audit_stripe_customer_id_plaintext()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stripe_customer_id IS NOT NULL AND NEW.stripe_customer_id LIKE 'cus_%' THEN
    RAISE WARNING
      '[SECURITY] Plaintext Stripe customer ID write attempted for tenant %. '
      'This violates REM-247 encryption policy. The write will be rejected by the CHECK constraint.',
      NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_tenants_stripe_id_audit
  BEFORE INSERT OR UPDATE OF stripe_customer_id ON tenants
  FOR EACH ROW
  EXECUTE FUNCTION trg_audit_stripe_customer_id_plaintext();

-- 4. Monitoring function: check for any plaintext IDs that slipped through.
CREATE OR REPLACE FUNCTION check_stripe_customer_id_encryption()
RETURNS TABLE(tenant_id UUID, has_plaintext BOOLEAN) LANGUAGE sql AS $$
  SELECT
    id AS tenant_id,
    (stripe_customer_id LIKE 'cus_%') AS has_plaintext
  FROM tenants
  WHERE stripe_customer_id IS NOT NULL;
$$;

COMMENT ON FUNCTION check_stripe_customer_id_encryption() IS
  'Security audit function. Returns (tenant_id, has_plaintext) for all tenants with a '
  'stripe_customer_id. has_plaintext=true indicates a PCI compliance violation. '
  'Expected: zero rows with has_plaintext=true after running migration 005.';

-- 5. Update the column comment to reflect the encryption requirement.
COMMENT ON COLUMN tenants.stripe_customer_id IS
  'Encrypted Stripe customer ID. '
  'Plaintext format: cus_xxxxxxxxxxxx. '
  'Encrypted by rembr-ui/src/lib/crypto.ts:encryptStripeCustomerId(). '
  'Decrypted on read by rembr-ui/src/lib/crypto.ts:decryptStripeCustomerId(). '
  'STRIPE_ENCRYPTION_KEY env var required. '
  'REM-247: plaintext writes rejected by chk_stripe_customer_id_not_plaintext constraint.';
