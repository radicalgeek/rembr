import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe('external authentication and admin error boundary', () => {
  it('normalises JWT and HTTP authentication failures to one response', () => {
    const auth = read('./auth.ts');
    const unified = read('./unified-auth-middleware.ts');
    const http = read('./index-http.ts');
    const jwtBlock = auth.slice(auth.indexOf('verifyJWT(token'), auth.indexOf('/** Extract Bearer token'));
    expect(jwtBlock).not.toContain('error.message');
    expect(jwtBlock).toContain("error: 'Authentication failed'");
    expect(unified).toContain("const EXTERNAL_AUTH_FAILURE = 'Authentication failed'");
    expect(http).toContain("res.status(401).json({ error: 'Authentication failed' })");
    expect(http).not.toContain("res.status(401).json({ error: authResult.error");
  });

  it('never serialises admin exception messages or logs whole Error objects', () => {
    const admin = read('./routes/admin.ts');
    expect(admin).not.toMatch(/status\(500\)[\s\S]{0,160}(?:\.message|String\(error\)|detail:)/);
    expect(admin).not.toMatch(/console\.error\([^\n]*,\s*error\)/);
    expect(admin).toContain("error: 'Admin operation failed', correlation_id: correlationId");
  });
});
