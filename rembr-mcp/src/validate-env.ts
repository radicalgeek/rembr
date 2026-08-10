/**
 * Startup Environment Validation (REM-63)
 *
 * Validates required environment variables on server startup.
 * Server will refuse to start if required secrets are missing.
 */

interface EnvVar {
  name: string;
  required: boolean;
  description: string;
  sensitive: boolean;
}

const REQUIRED_ENV_VARS: EnvVar[] = [
  // Database (one of these is required)
  { name: 'DATABASE_URL', required: false, description: 'Full PostgreSQL connection string', sensitive: true },
  { name: 'DB_HOST', required: false, description: 'PostgreSQL host', sensitive: false },

  // JWT (required)
  { name: 'JWT_SECRET', required: true, description: 'JWT signing secret (min 32 chars). Generate: openssl rand -base64 32', sensitive: true },

  // Admin API key (required — RAD-45: all /admin/* endpoints are guarded by X-Admin-Key)
  { name: 'ADMIN_API_KEY', required: true, description: 'Secret key for /admin/* endpoints. Header: X-Admin-Key. Generate: openssl rand -hex 32', sensitive: true },

  // API key HMAC secret (new keys use HMAC; existing sha256 keys remain valid)
  { name: 'API_KEY_SECRET', required: true, description: 'HMAC secret for API key hashing. Generate: openssl rand -hex 32', sensitive: true },
];

const OPTIONAL_ENV_VARS: EnvVar[] = [
  { name: 'DB_PORT', required: false, description: 'PostgreSQL port (default: 5432)', sensitive: false },
  { name: 'DB_NAME', required: false, description: 'PostgreSQL database name', sensitive: false },
  { name: 'DB_USER', required: false, description: 'PostgreSQL username', sensitive: false },
  { name: 'DB_PASSWORD', required: false, description: 'PostgreSQL password', sensitive: true },
  { name: 'DB_READ_HOST', required: false, description: 'Read replica host (optional)', sensitive: false },
  { name: 'DB_READ_PASSWORD', required: false, description: 'Read replica password (optional)', sensitive: true },
  { name: 'REDIS_URL', required: false, description: 'Redis connection URL', sensitive: true },
  { name: 'REDIS_HOST', required: false, description: 'Redis host (default: localhost)', sensitive: false },
  { name: 'REDIS_PORT', required: false, description: 'Redis port (default: 6379)', sensitive: false },
  { name: 'REDIS_PASSWORD', required: false, description: 'Redis password', sensitive: true },
  { name: 'OLLAMA_HOST', required: false, description: 'Ollama embedding service URL', sensitive: false },
  { name: 'OLLAMA_TEXT_HOST', required: false, description: 'Ollama text generation service URL', sensitive: false },
  { name: 'TEXT_GENERATION_PROVIDER', required: false, description: 'Text generation provider: ollama or openai-compatible', sensitive: false },
  { name: 'LM_STUDIO_BASE_URL', required: false, description: 'LM Studio/OpenAI-compatible text generation base URL', sensitive: false },
  { name: 'LM_STUDIO_MODEL', required: false, description: 'LM Studio model id for text generation', sensitive: false },
  { name: 'LM_STUDIO_API_KEY', required: false, description: 'LM Studio bearer token', sensitive: true },
  { name: 'OPENAI_COMPATIBLE_TEXT_BASE_URL', required: false, description: 'OpenAI-compatible text generation base URL', sensitive: false },
  { name: 'OPENAI_COMPATIBLE_TEXT_MODEL', required: false, description: 'OpenAI-compatible text generation model id', sensitive: false },
  { name: 'OPENAI_COMPATIBLE_API_KEY', required: false, description: 'OpenAI-compatible text generation bearer token', sensitive: true },
  { name: 'TEXT_GENERATION_TIMEOUT_MS', required: false, description: 'Text generation timeout in milliseconds (default: 60000 for Ollama, 180000 for OpenAI-compatible)', sensitive: false },
  { name: 'PORT', required: false, description: 'HTTP server port (default: 3000)', sensitive: false },
  { name: 'NODE_ENV', required: false, description: 'Node environment (development|production)', sensitive: false },
  { name: 'PUBLIC_URL', required: false, description: 'Public-facing URL of the service', sensitive: false },
  { name: 'OAUTH_EXPECTED_ISSUER', required: false, description: 'Exact OAuth issuer URL', sensitive: false },
  { name: 'OAUTH_EXPECTED_AUDIENCE', required: false, description: 'Exact RFC 8707 protected resource URL (origin + /mcp)', sensitive: false },
  { name: 'UI_BASE_URL', required: false, description: 'URL of the UI or self-hosted console', sensitive: false },
  { name: 'ENABLE_OPTIMIZATION', required: false, description: 'Reserved; unsafe tenant-wide auto-optimization remains disabled (default: false)', sensitive: false },
  { name: 'INITIALIZE_SCHEMA', required: false, description: 'Development-only owner schema initialisation (default: false)', sensitive: false },
  { name: 'CORS_ORIGIN', required: false, description: 'Allowed CORS origins (comma-separated)', sensitive: false },
  // RAD-62: Contradiction detection tuning
  { name: 'CONTRADICTION_DETECTION_TIMEOUT_MS', required: false, description: 'Per-LLM-call timeout for contradiction analysis (default: 8000ms)', sensitive: false },
  { name: 'CONTRADICTION_MAX_CANDIDATES', required: false, description: 'Max candidate pairs per store_memory contradiction check (default: 5)', sensitive: false },
  { name: 'OLLAMA_CONTRADICTION_MODEL', required: false, description: 'Ollama model for contradiction analysis (default: OLLAMA_TEXT_MODEL). Use a smaller model to reduce GPU contention.', sensitive: false },
];

export function validateEnvironment(): void {
  const errors: string[] = [];

  // Check required vars
  for (const env of REQUIRED_ENV_VARS) {
    if (env.required && !process.env[env.name]) {
      errors.push(`  ✗ ${env.name}: MISSING — ${env.description}`);
    }
  }

  // Database: require either DATABASE_URL or DB_HOST
  const hasDbUrl = !!process.env.DATABASE_URL;
  const hasDbHost = !!process.env.DB_HOST;
  if (!hasDbUrl && !hasDbHost) {
    errors.push('  ✗ DATABASE connection: MISSING — Set DATABASE_URL or DB_HOST+DB_NAME+DB_USER+DB_PASSWORD');
  }

  if (process.env.NODE_ENV === 'production') {
    if (process.env.INITIALIZE_SCHEMA === 'true' || process.env.ALLOW_STARTUP_SCHEMA_INIT === 'true') {
      errors.push('  ✗ Startup schema initialisation is forbidden in production; use owner migrations');
    }
    const secretNames = ['JWT_SECRET', 'ADMIN_API_KEY', 'API_KEY_SECRET', 'METRICS_SECRET'] as const;
    const placeholder = /(?:change[-_ ]?me|replace[-_ ]?me|your[-_ ]|example|default|password|secret[-_ ]?here|test[-_ ])/i;
    const configuredSecrets: Array<[string, string]> = [];

    for (const name of secretNames) {
      const value = process.env[name] || '';
      if (!value) {
        errors.push(`  ✗ ${name}: MISSING — required in production`);
        continue;
      }
      const distinctCharacters = new Set(value).size;
      if (value.length < 32 || distinctCharacters < 10 || placeholder.test(value)) {
        errors.push(`  ✗ ${name}: WEAK OR PLACEHOLDER — use at least 32 random characters`);
        continue;
      }
      configuredSecrets.push([name, value]);
    }

    for (let i = 0; i < configuredSecrets.length; i++) {
      for (let j = i + 1; j < configuredSecrets.length; j++) {
        if (configuredSecrets[i][1] === configuredSecrets[j][1]) {
          errors.push(`  ✗ ${configuredSecrets[i][0]} and ${configuredSecrets[j][0]} must use distinct secrets`);
        }
      }
    }

    const issuer = process.env.OAUTH_EXPECTED_ISSUER;
    if (!issuer) {
      errors.push('  ✗ OAUTH_EXPECTED_ISSUER: MISSING — required in production');
    }
    const resource = process.env.OAUTH_EXPECTED_AUDIENCE;
    if (!resource) {
      errors.push('  ✗ OAUTH_EXPECTED_AUDIENCE: MISSING — exact origin + /mcp is required in production');
    } else {
      try {
        const url = new URL(resource);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
            url.search || url.hash || url.pathname !== '/mcp' || resource !== `${url.origin}/mcp`) {
          errors.push('  ✗ OAUTH_EXPECTED_AUDIENCE: INVALID — must be the exact origin + /mcp URL');
        }
      } catch {
        errors.push('  ✗ OAUTH_EXPECTED_AUDIENCE: INVALID — must be the exact origin + /mcp URL');
      }
    }
  }

  if (errors.length > 0) {
    console.error('\n╔══════════════════════════════════════════════╗');
    console.error('║      STARTUP FAILED: Missing required env     ║');
    console.error('╚══════════════════════════════════════════════╝');
    console.error('\nRequired environment variables not set:');
    errors.forEach(e => console.error(e));
    console.error('\nSee rembr-mcp/.env.example for full documentation.');
    console.error('');
    process.exit(1);
  }

  // Non-production warning; production weakness is fatal above.
  const jwtSecret = process.env.JWT_SECRET || '';
  if (process.env.NODE_ENV !== 'production' && jwtSecret.length < 32) {
    console.warn(`⚠️  WARNING: JWT_SECRET is shorter than 32 characters (current: ${jwtSecret.length}). Use: openssl rand -base64 32`);
  }

  // Log what's configured (without values)
  if (process.env.NODE_ENV !== 'test') {
    console.log('✓ Environment validation passed');
    console.log(`  Database: ${hasDbUrl ? 'DATABASE_URL' : 'DB_HOST'}`);
    console.log(`  Redis: ${process.env.REDIS_URL ? 'REDIS_URL' : process.env.REDIS_HOST ? 'REDIS_HOST' : 'not configured (in-memory fallback)'}`);
    console.log(`  Ollama: ${process.env.OLLAMA_HOST || 'http://localhost:11434 (default)'}`);
    console.log(`  Text generation: ${process.env.TEXT_GENERATION_PROVIDER || (process.env.LM_STUDIO_BASE_URL ? 'openai-compatible' : 'ollama')} @ ${process.env.LM_STUDIO_BASE_URL || process.env.OPENAI_COMPATIBLE_TEXT_BASE_URL || process.env.OLLAMA_TEXT_HOST || process.env.OLLAMA_HOST || 'http://localhost:11434 (default)'}`);
    console.log(`  Admin: ${process.env.ADMIN_API_KEY ? '✓ protected (ADMIN_API_KEY)' : '✗ ADMIN_API_KEY missing (startup should have failed)'}`);
    console.log(`  Metrics: ${process.env.METRICS_SECRET ? '✓ protected' : '⚠️  unprotected (set METRICS_SECRET)'}`);
  }
}
