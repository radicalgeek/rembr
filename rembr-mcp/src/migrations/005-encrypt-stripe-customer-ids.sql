-- =====================================================
-- MIGRATION 005: Encrypt Existing Stripe Customer IDs
-- =====================================================
-- REM-255: Encrypt Stripe customer IDs for PCI-adjacent compliance
-- This migration encrypts all existing plaintext customer IDs
-- 
-- Prerequisites:
-- 1. STRIPE_ENCRYPTION_KEY must be set in environment (64 hex chars)
-- 2. Application code must be deployed with encryption/decryption logic
-- 3. Backup database before running this migration

-- Note: This migration requires application-level encryption function
-- Run via Node.js script, not directly in PostgreSQL

-- Migration script (to be run via Node.js):
-- 
-- import { prisma } from './lib/db';
-- import { encryptStripeCustomerId } from './lib/crypto';
-- 
-- async function migrateStripeCustomerIds() {
--   const tenants = await prisma.tenant.findMany({
--     where: {
--       stripe_customer_id: { not: null },
--     },
--   });
--   
--   for (const tenant of tenants) {
--     if (tenant.stripe_customer_id?.startsWith('cus_')) {
--       // Plaintext customer ID detected
--       const encrypted = encryptStripeCustomerId(tenant.stripe_customer_id);
--       await prisma.tenant.update({
--         where: { id: tenant.id },
--         data: { stripe_customer_id: encrypted },
--       });
--       console.log(`Encrypted customer ID for tenant ${tenant.id}`);
--     }
--   }
-- }

COMMENT ON COLUMN tenants.stripe_customer_id IS 'Encrypted Stripe customer ID. Plaintext format before encryption: cus_xxxxx';
