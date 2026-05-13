/**
 * Unit tests for RalphRLMService (REM-37)
 */

import { describe, it, expect, vi } from 'vitest';
import { RalphRLMService, RLMSession, AcceptanceCriterion } from './ralph-rlm.js';

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000037';
const SESSION_ID = 'sess0000-0000-0000-0000-000000000001';
const ITER_ID    = 'iter0000-0000-0000-0000-000000000001';

function makeAC(overrides: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return {
    id:          'ac-000001',
    description: 'System handles 1000 concurrent users',
    status:      'pending',
    ...overrides,
  };
}

function makeSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id:                  SESSION_ID,
    tenant_id:           TENANT,
    task_id:             'task-001',
    task_title:          'Test Task',
    status:              'active',
    acceptance_criteria: JSON.stringify([makeAC()]),
    current_plan:        null,
    regeneration_count:  0,
    metadata:            JSON.stringify({}),
    created_at:          new Date('2026-02-27'),
    updated_at:          new Date('2026-02-27'),
    completed_at:        null,
    ...overrides,
  };
}

function makeIterRow(overrides: Record<string, unknown> = {}) {
  return {
    id:               ITER_ID,
    session_id:       SESSION_ID,
    tenant_id:        TENANT,
    iteration_number: 1,
    plan_summary:     'Try approach A',
    approach:         'Direct implementation',
    outcome:          'failed',
    evidence:         JSON.stringify(['Tried X, got error Y']),
    error:            null,
    ac_met:           JSON.stringify([]),
    ac_failed:        JSON.stringify(['ac-000001']),
    duration_ms:      1500,
    started_at:       new Date('2026-02-27'),
    completed_at:     new Date('2026-02-27'),
    metadata:         JSON.stringify({}),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────
// _formatSession / _formatIteration (via getSession)
// ─────────────────────────────────────────────────────────
describe('RalphRLMService — session formatting', () => {
  it('formats a session with iterations correctly', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })                      // ensureSchema
        .mockResolvedValueOnce({ rows: [makeSessionRow()] })      // session query
        .mockResolvedValueOnce({ rows: [makeIterRow()] }),        // iteration query
    } as any;

    const svc = new RalphRLMService(pool, TENANT);
    const session = await svc.getSession(SESSION_ID);

    expect(session).not.toBeNull();
    expect(session!.id).toBe(SESSION_ID);
    expect(session!.task_title).toBe('Test Task');
    expect(session!.acceptance_criteria).toHaveLength(1);
    expect(session!.acceptance_criteria[0].status).toBe('pending');
    expect(session!.iterations).toHaveLength(1);
    expect(session!.iterations[0].outcome).toBe('failed');
    expect(session!.iterations[0].evidence).toEqual(['Tried X, got error Y']);
  });

  it('returns null when session not found', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })   // ensureSchema
        .mockResolvedValueOnce({ rows: [] })   // session query (empty)
        .mockResolvedValueOnce({ rows: [] }),  // iteration query
    } as any;

    const svc = new RalphRLMService(pool, TENANT);
    expect(await svc.getSession('not-found')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// createSession
// ─────────────────────────────────────────────────────────
describe('RalphRLMService — createSession', () => {
  it('creates AC list with unique IDs', async () => {
    const capturedArgs: unknown[][] = [];
    const pool = {
      query: vi.fn().mockImplementation((_sql: string, params?: unknown[]) => {
        if (params) capturedArgs.push(params);
        return Promise.resolve({ rows: [makeSessionRow()] });
      }),
    } as any;

    const svc = new RalphRLMService(pool, TENANT);
    await svc.createSession('task-001', 'My Task', ['AC 1', 'AC 2', 'AC 3']);

    // Find the INSERT call — params[3] is the AC JSON
    const insertCall = capturedArgs.find(p => Array.isArray(p) && p.length >= 4);
    expect(insertCall).toBeDefined();
    const acJson = JSON.parse(insertCall![3] as string);
    expect(acJson).toHaveLength(3);
    // All IDs should be unique
    const ids = acJson.map((a: AcceptanceCriterion) => a.id);
    expect(new Set(ids).size).toBe(3);
    expect(acJson[0].status).toBe('pending');
  });
});

// ─────────────────────────────────────────────────────────
// evaluateAC
// ─────────────────────────────────────────────────────────
describe('RalphRLMService — evaluateAC', () => {
  it('auto-completes session when all AC are met/skipped', async () => {
    const queries: string[] = [];
    const pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        queries.push(sql.trim()); // store full SQL, not truncated
        if (sql.includes('SELECT') && sql.includes('rlm_sessions')) {
          return Promise.resolve({ rows: [makeSessionRow()] });
        }
        if (sql.includes('rlm_iterations')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [makeSessionRow({ status: 'complete' })] });
      }),
    } as any;

    const svc = new RalphRLMService(pool, TENANT);
    await svc.evaluateAC(SESSION_ID, [{ id: 'ac-000001', status: 'met', evidence: 'Tests pass' }]);

    // UPDATE query should include status = 'complete' auto-complete
    const updateSql = queries.find(q => q.includes('UPDATE rlm_sessions'));
    expect(updateSql).toBeDefined();
    expect(updateSql!.toLowerCase()).toContain('complete');
  });

  it('does not auto-complete when some AC still pending', async () => {
    const twoAC = [makeAC({ id: 'ac-1' }), makeAC({ id: 'ac-2', description: 'Second criterion' })];
    const rowWithTwoAC = makeSessionRow({ acceptance_criteria: JSON.stringify(twoAC) });

    const queries: string[] = [];
    const pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        queries.push(sql.trim()); // store full SQL, not truncated
        if (sql.includes('SELECT') && sql.includes('rlm_sessions')) return Promise.resolve({ rows: [rowWithTwoAC] });
        if (sql.includes('rlm_iterations')) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [rowWithTwoAC] });
      }),
    } as any;

    const svc = new RalphRLMService(pool, TENANT);
    // Only mark ac-1 as met, ac-2 remains pending
    await svc.evaluateAC(SESSION_ID, [{ id: 'ac-1', status: 'met', evidence: 'Done' }]);

    const updateSql = queries.find(q => q.includes('UPDATE rlm_sessions'));
    // When not all AC are met, 'complete' should NOT appear in the UPDATE
    expect(updateSql).toBeDefined();
    expect(updateSql!.toLowerCase()).not.toContain("status = 'complete'");
  });
});

// ─────────────────────────────────────────────────────────
// startIteration / completeIteration
// ─────────────────────────────────────────────────────────
describe('RalphRLMService — iteration lifecycle', () => {
  it('startIteration uses next sequential number', async () => {
    const capturedParams: unknown[][] = [];
    const pool = {
      query: vi.fn().mockImplementation((_sql: string, params?: unknown[]) => {
        if (params) capturedParams.push(params);
        // Count query returns 2 existing iterations
        if (_sql.includes('COUNT(*)')) return Promise.resolve({ rows: [{ count: '2' }] });
        return Promise.resolve({ rows: [makeIterRow({ iteration_number: 3 })] });
      }),
    } as any;

    const svc = new RalphRLMService(pool, TENANT);
    const iter = await svc.startIteration(SESSION_ID, 'Plan v3', 'Try approach C');
    expect(iter.iteration_number).toBe(3);
  });

  it('completeIteration records outcome and evidence', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [makeIterRow({
        outcome: 'success',
        evidence: JSON.stringify(['Test passed', 'Coverage 95%']),
        ac_met: JSON.stringify(['ac-000001']),
      })] }),
    } as any;

    const svc = new RalphRLMService(pool, TENANT);
    const iter = await svc.completeIteration(
      ITER_ID, 'success', ['Test passed', 'Coverage 95%'], ['ac-000001'],
    );
    expect(iter.outcome).toBe('success');
    expect(iter.evidence).toEqual(['Test passed', 'Coverage 95%']);
    expect(iter.ac_met).toContain('ac-000001');
  });
});

// ─────────────────────────────────────────────────────────
// requestRegeneration
// ─────────────────────────────────────────────────────────
describe('RalphRLMService — requestRegeneration', () => {
  it('generates structured prompt with failed approaches', async () => {
    const pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('ensureSchema') || sql.trim().startsWith('CREATE')) return Promise.resolve({ rows: [] });
        if (sql.includes('SELECT') && sql.includes('rlm_sessions')) return Promise.resolve({ rows: [makeSessionRow()] });
        if (sql.includes('rlm_iterations')) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [] });
      }),
    } as any;

    const svc = new RalphRLMService(pool, TENANT);
    const result = await svc.requestRegeneration({
      session_id:        SESSION_ID,
      reason:            'Tests keep failing despite 3 attempts',
      stuck_evidence:    ['Error: ECONNREFUSED on port 5432', 'Test suite timeout after 60s'],
      failed_approaches: ['Direct DB connection', 'Mock DB approach'],
      constraints:       ['Must use PostgreSQL', 'No external services in tests'],
    });

    expect(result.session_id).toBe(SESSION_ID);
    expect(result.prompt_for_agent).toContain('Plan Regeneration Required');
    expect(result.prompt_for_agent).toContain('Tests keep failing');
    expect(result.prompt_for_agent).toContain('Direct DB connection');
    expect(result.what_failed.length).toBeGreaterThan(0);
    expect(result.suggested_alternatives.length).toBeGreaterThan(0);
    expect(result.regeneration_id).toBeDefined();
  });

  it('throws when session not found', async () => {
    const pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT') && sql.includes('rlm_sessions')) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [] });
      }),
    } as any;
    const svc = new RalphRLMService(pool, TENANT);
    await expect(svc.requestRegeneration({
      session_id: 'ghost', reason: 'test', stuck_evidence: [], failed_approaches: [], constraints: [],
    })).rejects.toThrow(/not found/i);
  });
});

// ─────────────────────────────────────────────────────────
// State export / import
// ─────────────────────────────────────────────────────────
describe('RalphRLMService — exportState / importState', () => {
  it('exportState produces valid JSON with schema_version', () => {
    const session: RLMSession = {
      id: SESSION_ID, tenant_id: TENANT, task_id: 'task-001', task_title: 'Test',
      status: 'active', acceptance_criteria: [makeAC()], iterations: [],
      current_plan: 'Do X then Y', regeneration_count: 1,
      created_at: '2026-02-27T00:00:00Z', updated_at: '2026-02-27T00:00:00Z',
      metadata: {},
    };
    const svc = new RalphRLMService({ query: vi.fn() } as any, TENANT);
    const json = svc.exportState(session);
    const parsed = JSON.parse(json);
    expect(parsed.schema_version).toBe('1.0');
    expect(parsed.session.id).toBe(SESSION_ID);
    expect(parsed.session.task_title).toBe('Test');
  });

  it('importState upserts session and iterations', async () => {
    const session: RLMSession = {
      id: SESSION_ID, tenant_id: TENANT, task_id: 'task-001', task_title: 'Test',
      status: 'active', acceptance_criteria: [makeAC()], iterations: [],
      current_plan: null, regeneration_count: 0,
      created_at: '2026-02-27T00:00:00Z', updated_at: '2026-02-27T00:00:00Z',
      metadata: {},
    };
    const stateJson = JSON.stringify({ schema_version: '1.0', exported_at: '', session });

    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [makeSessionRow()] }),
    } as any;

    const svc = new RalphRLMService(pool, TENANT);
    const imported = await svc.importState(stateJson);
    expect(imported.id).toBe(SESSION_ID);
  });
});
