/**
 * Admin Authentication Middleware (RAD-45)
 *
 * Guards all `/admin/*` routes behind the `X-Admin-Key` header.
 *
 * Required environment variable: `ADMIN_API_KEY`
 * The server refuses to start (see validate-env.ts) if this is not set.
 *
 * Behaviour:
 *   - Requests with a correct `X-Admin-Key` header → allowed through
 *   - Missing or incorrect header → 401 Unauthorized
 *
 * Usage:
 *   app.use('/admin', adminAuthMiddleware);
 *   app.use('/admin', createAdminRouter(deps));
 */

import type { Request, Response, NextFunction } from 'express';

/** The header name clients must send. */
export const ADMIN_KEY_HEADER = 'x-admin-key';

/**
 * Express middleware that enforces X-Admin-Key authentication on admin routes.
 *
 * ADMIN_API_KEY is validated at startup by validate-env.ts, so by the time
 * this middleware runs, the env var is guaranteed to be set.
 */
export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const adminApiKey = process.env.ADMIN_API_KEY;

  // Defensive: should never happen because validate-env.ts exits on missing key.
  // Kept as a belt-and-suspenders guard in case middleware is used standalone.
  if (!adminApiKey) {
    res.status(503).json({
      error: 'Admin endpoints are unavailable. ADMIN_API_KEY is not configured.',
    });
    return;
  }

  const provided = req.headers[ADMIN_KEY_HEADER] as string | undefined;

  if (!provided || provided !== adminApiKey) {
    res.status(401).json({ error: 'Unauthorized: X-Admin-Key required' });
    return;
  }

  next();
}
