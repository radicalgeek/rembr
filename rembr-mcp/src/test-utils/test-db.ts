/**
 * Shared test-database helpers for integration tests.
 *
 * Convention: integration tests run against a disposable `rembr_test`
 * database (blank is fine) and bootstrap exactly the tables they need —
 * by applying the real migration files, never by duplicating DDL.
 *
 * Connection resolution (first match wins):
 *   TEST_DATABASE_URL → DATABASE_URL → DB_* components → localhost defaults.
 * The DB_* components match what .gitlab-ci.yml provides; localhost matches
 * the docker-compose postgres (see SELF-HOSTING.md) and CI's service alias
 * on Kubernetes executors.
 */

import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function testConnectionString(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TEST_DATABASE_URL) return env.TEST_DATABASE_URL;
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const host = env.DB_HOST || 'localhost';
  const port = env.DB_PORT || '5432';
  const user = env.DB_USER || 'postgres';
  const password = env.DB_PASSWORD || 'postgres';
  const name = env.DB_NAME || 'rembr_test';
  return `postgresql://${user}:${password}@${host}:${port}/${name}`;
}

/**
 * Create a pool, optionally namespaced to a per-test-file PostgreSQL schema.
 *
 * Test files that CREATE their own tables must pass a unique schema name:
 * different files model different products (board tasks vs tenant tasks,
 * 768- vs 1536-dim memories) and would otherwise fight over table names in
 * the shared database. `public` stays on the search_path so the pgvector
 * type resolves.
 */
export function createTestPool(schema?: string): Pool {
  const pool = new Pool({
    connectionString: testConnectionString(),
    ...(schema ? { options: `-c search_path=${schema},public` } : {}),
  });
  if (schema) {
    // Lazily create the schema before the first real query so test files
    // need no extra bootstrap step. Promise-style pool.query only (which is
    // all the tests and services use).
    const originalQuery = pool.query.bind(pool);
    let schemaReady: Promise<unknown> | undefined;
    (pool as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
      schemaReady ??= originalQuery(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      return schemaReady.then(() => (originalQuery as (...a: unknown[]) => unknown)(...args));
    };
  }
  return pool;
}

/** Connection string form of the schema namespacing, for code that builds its own Pool. */
export function schemaConnectionString(schema: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = testConnectionString(env);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}options=${encodeURIComponent(`-c search_path=${schema},public`)}`;
}

export async function ensureSchema(pool: Pool, schema: string): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
}

/** Connection string pointing at a different database on the same server. */
export function dbConnectionString(dbName: string, env: NodeJS.ProcessEnv = process.env): string {
  const url = new URL(testConnectionString(env));
  url.pathname = `/${dbName}`;
  return url.toString();
}

/**
 * Create a dedicated database for a test file (idempotent). Use this instead
 * of schema namespacing when the code under test manages its own pools
 * (e.g. MemoryDatabase) and therefore cannot be search_path-scoped.
 */
export async function ensureTestDatabase(dbName: string): Promise<void> {
  const admin = new Pool({ connectionString: testConnectionString() });
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${dbName}`);
    }
  } catch (error: unknown) {
    // 42P04 = database already exists (raced with another worker)
    if ((error as { code?: string }).code !== '42P04') throw error;
  } finally {
    await admin.end();
  }
}

/** Pool against a dedicated per-file test database. */
export function createDbPool(dbName: string): Pool {
  return new Pool({ connectionString: dbConnectionString(dbName) });
}

/** pgvector must exist before any table with a vector column is created. */
export async function ensureVectorExtension(pool: Pool): Promise<void> {
  // Pin to public: from a schema-scoped pool, a bare CREATE EXTENSION would
  // install the vector type into that private schema and hide it from
  // every other connection.
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
}

/**
 * Minimal stand-in for the tenants table (owned by the UI-side schema in
 * production). Deliberately has no unique email constraint so parallel test
 * files can insert their own tenants without colliding.
 */
export async function ensureTenantsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      plan VARCHAR(50) NOT NULL DEFAULT 'free',
      status VARCHAR(50) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/** Apply real migration files from src/migrations (all are idempotent). */
export async function applyMigrations(pool: Pool, ...filenames: string[]): Promise<void> {
  for (const filename of filenames) {
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
    await pool.query(sql);
  }
}
