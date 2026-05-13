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

  // API key HMAC secret (required — prevents offline/rainbow-table attacks against API key hashes)
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
  { name: 'PORT', required: false, description: 'HTTP server port (default: 3000)', sensitive: false },
  { name: 'NODE_ENV', required: false, description: 'Node environment (development|production)', sensitive: false },
  { name: 'PUBLIC_URL', required: false, description: 'Public-facing URL of the service', sensitive: false },
  { name: 'UI_BASE_URL', required: false, description: 'URL of the rembr-ui service', sensitive: false },
  { name: 'ENABLE_OPTIMIZATION', required: false, description: 'Enable auto-optimization (default: true)', sensitive: false },
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

  // Warn about JWT_SECRET length
  const jwtSecret = process.env.JWT_SECRET || '';
  if (jwtSecret.length < 32) {
    const msg = `JWT_SECRET is shorter than 32 characters (current: ${jwtSecret.length}). Use: openssl rand -base64 32`;
    if (process.env.NODE_ENV === 'production') {
      console.error(`🔴 SECURITY: ${msg}`);
      process.exit(1);
    }
    console.warn(`⚠️  WARNING: ${msg}`);
  }

  // REM-28 / RAD-45: Production security checks
  if (process.env.NODE_ENV === 'production') {
    // ADMIN_API_KEY is now a hard-required var (validated above), so this is belt-and-suspenders.
    if (!process.env.ADMIN_API_KEY) {
      console.error('🔴 SECURITY: ADMIN_API_KEY is not set — server should have exited above.');
    }
    if (!process.env.METRICS_SECRET) {
      console.error('🔴 SECURITY: METRICS_SECRET is not set — /metrics endpoint will return 403 in production.');
      console.error('   Generate: openssl rand -hex 32');
    }
    if (jwtSecret === 'your-jwt-secret-here' || jwtSecret.includes('change-me')) {
      console.error('\n╔══════════════════════════════════════════════╗');
      console.error('║   STARTUP FAILED: Default secret detected     ║');
      console.error('╚══════════════════════════════════════════════╝');
      console.error('JWT_SECRET appears to be a placeholder. Never use example secrets in production.');
      process.exit(1);
    }
  }

  // Log what's configured (without values)
  if (process.env.NODE_ENV !== 'test') {
    console.log('✓ Environment validation passed');
    console.log(`  Database: ${hasDbUrl ? 'DATABASE_URL' : 'DB_HOST'}`);
    console.log(`  Redis: ${process.env.REDIS_URL ? 'REDIS_URL' : process.env.REDIS_HOST ? 'REDIS_HOST' : 'not configured (in-memory fallback)'}`);
    console.log(`  Ollama: ${process.env.OLLAMA_HOST || 'http://localhost:11434 (default)'}`);
    console.log(`  Admin: ${process.env.ADMIN_API_KEY ? '✓ protected (ADMIN_API_KEY)' : '✗ ADMIN_API_KEY missing (startup should have failed)'}`);
    console.log(`  Metrics: ${process.env.METRICS_SECRET ? '✓ protected' : '⚠️  unprotected (set METRICS_SECRET)'}`);
  }
}
