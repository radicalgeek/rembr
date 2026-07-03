import { defineConfig } from 'vitest/config';

/**
 * The suite is split in two:
 *
 *   npm run test:unit         — no external services; runs anywhere
 *   npm run test:integration  — requires PostgreSQL (blank rembr_test DB is
 *                               fine; tests bootstrap their own tables via
 *                               src/test-utils/test-db.ts). Runs files
 *                               sequentially: they share one database.
 *   npm test                  — both (requires PostgreSQL)
 *
 * Live-service e2e tests gate themselves on env vars instead of being
 * excluded here: week14-features needs TEST_MCP_URL, multi-server needs
 * RUN_MULTI_SERVER_TESTS=true.
 */
const INTEGRATION_TESTS = [
  'src/audit-logger.test.ts',
  'src/budget-management.test.ts',
  'src/checkpoint-service.test.ts',
  'src/context-analytics.test.ts',
  'src/context-monitor.test.ts',
  'src/embedding-model-consistency.test.ts',
  'src/iteration-tracking.test.ts',
  'src/multi-server.integration.test.ts',
  'src/optimization/compaction-service.test.ts',
  'src/pii-integration.test.ts',
  'src/plan-regeneration.test.ts',
  'src/task-analytics.test.ts',
  'src/task-export.test.ts',
  'src/task-handoff.test.ts',
  'src/task-service.test.ts',
  'src/token-budget.test.ts',
  'src/work-queue.test.ts',
  'tests/integration/**/*.test.ts',
  'tests/week14-features.test.ts',
];

const suite = process.env.TEST_SUITE; // 'unit' | 'integration' | undefined = all
const isCI = process.env.CI === 'true';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    reporters: ['verbose', 'junit'],
    outputFile: {
      junit: './test-results.xml'
    },
    ...(suite === 'integration'
      ? {
          include: INTEGRATION_TESTS,
          // Integration tests share one database; run files sequentially to
          // avoid cross-file table/data races.
          fileParallelism: false,
        }
      : {}),
    exclude: [
      'node_modules/**',
      'dist/**',
      'tests/e2e/**', // Playwright e2e tests - run separately
      ...(suite === 'unit' ? INTEGRATION_TESTS : []),
    ],
    testTimeout: suite === 'integration' || isCI ? 30000 : 5000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: [
        'src/auth.ts',
        'src/ollama-provider.ts'
      ],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.test.ts',
        'src/test.ts',
        'src/index-http.ts',
        'src/database.ts',
        'src/memory-service.ts',
        'src/context-service.ts',
        'src/compilation-service.ts',
        'src/snapshot-service.ts'
      ],
      thresholds: {
        lines: 70,
        functions: 85,
        branches: 75,
        statements: 70
      }
    }
  }
});
