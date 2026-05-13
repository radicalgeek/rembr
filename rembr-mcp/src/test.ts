import { MemoryDatabase } from './database.js';
import { MemoryService } from './memory-service.js';
import { OllamaEmbeddingProvider } from './ollama-provider.js';
import { AuthService } from './auth.js';

async function test() {
  console.log('Rembr MCP Server - Test Suite\n');

  // Test 1: Database initialization
  console.log('1. Testing database initialization...');
  const db = new MemoryDatabase(process.env.DATABASE_URL);
  
  try {
    await db.initializeSchema();
    console.log('✓ Database schema initialized\n');
  } catch (error) {
    console.error('✗ Database initialization failed:', error);
    process.exit(1);
  }

  // Test 2: Ollama connection
  console.log('2. Testing Ollama connection...');
  const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
  const embeddingProvider = OllamaEmbeddingProvider.createDefault(ollamaHost);
  
  try {
    const isAvailable = await embeddingProvider.isAvailable();
    if (isAvailable) {
      console.log(`✓ Ollama available at ${ollamaHost}\n`);
    } else {
      console.log(`⚠ Ollama not available at ${ollamaHost} (semantic search will be disabled)\n`);
    }
  } catch (error) {
    console.log(`⚠ Ollama check failed: ${error}\n`);
  }

  // Test 3: Authentication
  console.log('3. Testing authentication...');
  const authService = new AuthService();
  
  // Generate test JWT
  const testJWT = authService.generateJWT('test-tenant-123', 'test-user-456');
  console.log('Generated test JWT:', testJWT.substring(0, 50) + '...');
  
  // Verify JWT
  const authResult = authService.verifyJWT(testJWT);
  if (authResult.success && authResult.tenantId === 'test-tenant-123') {
    console.log('✓ JWT generation and verification working\n');
  } else {
    console.error('✗ JWT verification failed:', authResult.error);
    process.exit(1);
  }

  // Test 4: API Key format validation
  console.log('4. Testing API key format validation...');
  const validKey = 'mb_live_' + 'a'.repeat(40);
  const invalidKey = 'invalid_key';
  
  if (authService.validateApiKeyFormat(validKey)) {
    console.log('✓ Valid API key format accepted');
  } else {
    console.error('✗ Valid API key format rejected');
  }
  
  if (!authService.validateApiKeyFormat(invalidKey)) {
    console.log('✓ Invalid API key format rejected\n');
  } else {
    console.error('✗ Invalid API key format accepted');
  }

  console.log('All tests completed!');
  console.log('\nTo run the server:');
  console.log('  npm start');
  console.log('\nOr with custom settings:');
  console.log('  DATABASE_URL=... OLLAMA_HOST=... PORT=3000 npm start');

  await db.close();
  process.exit(0);
}

test().catch(console.error);
