/** Disposable database initialised from the OSS schema and real migrations. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { MemoryDatabase } from '../database.js';
import { applyMigrations, dbConnectionString, ensureTestDatabase } from './test-db.js';

export async function createRuntimeDatabase(name: string) {
  await ensureTestDatabase(name);
  const connectionString = dbConnectionString(name);
  const pool = new Pool({ connectionString });
  await pool.query(readFileSync(fileURLToPath(new URL('../../../deploy/k8s/02-create-schema.sql', import.meta.url)), 'utf8'));
  const db = new MemoryDatabase(connectionString);
  await db.initializeSchema();
  await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rembr_app') THEN CREATE ROLE rembr_app; END IF; END $$`);
  await applyMigrations(pool, '001-auto-optimization-tables.sql', '002-pii-detection.sql', '007-embedding-model-consistency.sql', '024-agentic-features-schema.sql');
  return { pool, db, connectionString };
}
