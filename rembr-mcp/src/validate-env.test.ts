import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateEnvironment } from './validate-env.js';

const strong = (prefix: string) => `${prefix}-A1b2C3d4E5f6G7h8J9k0-${prefix}-fixture`;

describe('production OAuth resource configuration', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', 'postgresql://rembr_app:fixture@database/rembr');
    vi.stubEnv('JWT_SECRET', strong('jwt'));
    vi.stubEnv('ADMIN_API_KEY', strong('admin'));
    vi.stubEnv('API_KEY_SECRET', strong('apikey'));
    vi.stubEnv('METRICS_SECRET', strong('metrics'));
    vi.stubEnv('OAUTH_EXPECTED_ISSUER', 'https://rembr.example');
    vi.stubEnv('OAUTH_EXPECTED_AUDIENCE', 'https://rembr.example/mcp');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('accepts the exact origin + /mcp protected resource', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('unexpected exit');
    }) as never);

    expect(() => validateEnvironment()).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
  });

  it('fails closed for a missing or origin-only protected resource', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    vi.stubEnv('OAUTH_EXPECTED_AUDIENCE', 'https://rembr.example');
    expect(() => validateEnvironment()).toThrow('exit:1');

    exit.mockClear();
    vi.stubEnv('OAUTH_EXPECTED_AUDIENCE', '');
    expect(() => validateEnvironment()).toThrow('exit:1');
  });
});

describe('startup provider summary', () => {
  const apiKey = 'fixture-azure-key-0123456789-not-printed';
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DATABASE_URL', 'postgresql://rembr_app:fixture@database/rembr');
    vi.stubEnv('JWT_SECRET', strong('jwt'));
    vi.stubEnv('ADMIN_API_KEY', strong('admin'));
    vi.stubEnv('API_KEY_SECRET', strong('apikey'));
    vi.stubEnv('EMBEDDING_PROVIDER', '');
    vi.stubEnv('TEXT_GENERATION_PROVIDER', '');
    vi.stubEnv('OLLAMA_HOST', '');
    vi.stubEnv('OLLAMA_TEXT_HOST', '');
    vi.stubEnv('LM_STUDIO_BASE_URL', '');
    vi.stubEnv('AZURE_OPENAI_ENDPOINT', '');
    vi.stubEnv('AZURE_OPENAI_API_KEY', '');
    vi.stubEnv('AZURE_OPENAI_EMBEDDING_DEPLOYMENT', '');
    vi.stubEnv('AZURE_OPENAI_TEXT_DEPLOYMENT', '');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('unexpected exit');
    }) as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const output = () => logSpy.mock.calls.map(call => call.join(' ')).join('\n');

  it('shows the Ollama URL and no Azure details for the default providers', () => {
    validateEnvironment();
    expect(output()).toContain('Ollama: http://localhost:11434 (default)');
    expect(output()).not.toContain('Azure OpenAI');
  });

  it('shows Azure endpoint and deployments without an Ollama URL when azure is selected', () => {
    vi.stubEnv('EMBEDDING_PROVIDER', 'azure');
    vi.stubEnv('TEXT_GENERATION_PROVIDER', 'azure');
    vi.stubEnv('AZURE_OPENAI_ENDPOINT', 'https://fixture-resource.openai.azure.com');
    vi.stubEnv('AZURE_OPENAI_API_KEY', apiKey);
    vi.stubEnv('AZURE_OPENAI_EMBEDDING_DEPLOYMENT', 'fixture-embedding');
    vi.stubEnv('AZURE_OPENAI_TEXT_DEPLOYMENT', 'fixture-text');

    validateEnvironment();
    const text = output();
    expect(text).toContain('Azure OpenAI: https://fixture-resource.openai.azure.com (embedding deployment: fixture-embedding, text deployment: fixture-text)');
    expect(text).toContain('Text generation: azure');
    expect(text).not.toContain('Ollama:');
    expect(text).not.toContain('localhost:11434');
    expect(text).not.toContain(apiKey);
  });
});
