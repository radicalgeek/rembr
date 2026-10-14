#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { buildBootstrap } from './bootstrap-tenant.mjs'

const syntheticKey = `mb_${'live_'}${'A'.repeat(64)}`
const environment = {
  TENANT_NAME: "Agent O'Brien",
  TENANT_EMAIL: 'AGENT@EXAMPLE.TEST',
  KEY_NAME: "O'Brien bootstrap",
}

test('generates a scoped non-expiring agent-first bootstrap transaction', () => {
  const { sql, message } = buildBootstrap(environment, syntheticKey)
  const keys = message.match(/mb_live_[A-Za-z0-9]{64}/g) ?? []
  assert.equal(keys.length, 1)
  const [key] = keys
  const keyHash = createHash('sha256').update(key).digest('hex')

  assert.equal(sql.includes(key), false)
  assert.match(sql, /^-- rembr self-host bootstrap/)
  assert.match(sql, /BEGIN;/)
  assert.match(sql, /pg_advisory_xact_lock/)
  for (const value of ["Agent O'Brien", 'agent@example.test', "O'Brien bootstrap"]) {
    assert.match(sql, new RegExp(Buffer.from(value, 'utf8').toString('base64')))
    assert.equal(sql.includes(value), false)
  }
  assert.match(sql, new RegExp(keyHash))
  assert.match(sql, new RegExp(key.slice(0, 20)))
  assert.match(sql, /existing_status IS DISTINCT FROM 'unclaimed'/)
  assert.match(sql, /existing_created_by_agent IS DISTINCT FROM TRUE/)
  assert.match(sql, /existing_plan NOT IN \('free', 'dev'\)/)
  assert.match(sql, /'Default Project'/)
  assert.match(sql, /existing_project_is_personal IS DISTINCT FROM FALSE/)
  assert.match(sql, /existing_project_owner IS NOT NULL/)
  assert.match(sql, /NULL,\s*'agent_bootstrap'/)
  assert.match(sql, /'memory:read', 'memory:write', 'context:manage', 'snapshot:manage'/)
  // Plan limits come from the canonical per-plan catalogue (free defaults shown).
  assert.match(sql, /CASE existing_plan[\s\S]*ELSE 1000/)
  assert.match(sql, /WHEN 'pro' THEN 25000/)
  assert.match(sql, /ON CONFLICT \(tenant_id\) DO UPDATE/)
  assert.match(sql, /COMMIT;/)
  assert.doesNotMatch(sql, /ON CONFLICT \(email\) DO UPDATE/)
})

test('honours TENANT_PLAN for new tenants and rejects unknown plans', () => {
  const { sql, message } = buildBootstrap({ ...environment, TENANT_PLAN: 'pro' }, syntheticKey)
  assert.match(sql, /'pro', 'unclaimed', TRUE/)
  assert.match(message, /Plan: pro/)
  assert.throws(
    () => buildBootstrap({ ...environment, TENANT_PLAN: 'platinum' }, syntheticKey),
    /TENANT_PLAN/,
  )
})

test('rejects unsafe bootstrap metadata before generating a credential', () => {
  assert.throws(
    () => buildBootstrap({ ...environment, TENANT_NAME: 'unsafe\nname' }, syntheticKey),
    /TENANT_NAME/,
  )
})

test('keeps SQL delimiters in operator metadata out of the generated program', () => {
  const delimiter = '$rembr_self_host_bootstrap$'
  const { sql } = buildBootstrap(
    { ...environment, TENANT_NAME: `Agent ${delimiter}` },
    syntheticKey,
  )
  assert.equal(sql.includes(`Agent ${delimiter}`), false)
  assert.match(
    sql,
    new RegExp(Buffer.from(`Agent ${delimiter}`, 'utf8').toString('base64')),
  )
})
