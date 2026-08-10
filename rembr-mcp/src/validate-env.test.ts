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
