import { defineConfig } from 'vitest/config';

// Skip integration tests in CI (no external services like Ollama)
const isCI = process.env.CI === 'true';
console.log('CI environment:', isCI, 'CI env var:', process.env.CI);

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    reporters: ['verbose', 'junit'],
    outputFile: {
      junit: './test-results.xml'
    },
    exclude: [
      'node_modules/**',
      'dist/**',
      'tests/e2e/**',  // Playwright e2e tests - run separately
      ...(isCI ? [
        '**/ollama-*.test.ts',
        '**/ollama*.test.ts', 
        'src/ollama-client.test.ts',
        '**/week14-features.test.ts',
        'tests/week14-features.test.ts',
        '**/*.integration.test.ts',
        'src/task-analytics.test.ts',  // REM-56: Requires Mission Control schema
        'src/pii-integration.test.ts', // REM-50: Integration test (requires full DB schema)
        'src/embedding-model-consistency.test.ts',  // Requires real DB with pgvector extension
        'src/work-queue.test.ts',  // REM-72: Integration test requiring real DB + Redis
        'src/task-handoff.test.ts',  // REM-73: Integration test requiring real DB
        'src/optimization/compaction-service.test.ts'  // REM-88: Requires real DB with pgvector
      ] : [])
    ],
    testTimeout: isCI ? 30000 : 5000,
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
