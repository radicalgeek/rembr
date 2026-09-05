import type { NextFunction, Request, RequestHandler, Response } from 'express';

const API_KEY_PATTERN = /^mb_live_(?:[A-Za-z0-9]{32}|[A-Za-z0-9]{64})$/;
const BEARER_PATTERN = /^Bearer [^\s,\x00-\x1f\x7f]{8,8192}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const LARGE_BODY_BYTES = 64 * 1024;

export interface McpPreParserLimits {
  requestsPerMinute?: number;
  largeBodiesPerMinute?: number;
  reservedBytesPerMinute?: number;
}

function rawHeaderCount(req: Request, name: string): number {
  const raw = req.rawHeaders || [];
  let count = 0;
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index]?.toLowerCase() === name) count++;
  }
  return count;
}

function reject(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

/** Header and allocation admission gate mounted before express.json(). */
export function createMcpPreParserBoundary(limits: McpPreParserLimits = {}): RequestHandler {
  const requestLimit = limits.requestsPerMinute ?? 5_000;
  const largeBodyLimit = limits.largeBodiesPerMinute ?? 120;
  const byteLimit = limits.reservedBytesPerMinute ?? 256 * 1024 * 1024;
  if (![requestLimit, largeBodyLimit, byteLimit].every(Number.isSafeInteger)
      || requestLimit < 1 || largeBodyLimit < 1 || byteLimit < MAX_JSON_BYTES) {
    throw new Error('Invalid MCP pre-parser limits');
  }

  let windowStartedAt = Date.now();
  let requests = 0;
  let largeBodies = 0;
  let reservedBytes = 0;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST' || req.path !== '/mcp') {
      next();
      return;
    }

    // rawHeaders catches duplicate values which Node/Express may otherwise
    // coalesce into one ambiguous string.
    const apiKeyOccurrences = rawHeaderCount(req, 'x-api-key');
    const authorizationOccurrences = rawHeaderCount(req, 'authorization');
    const apiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined;
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    if (apiKeyOccurrences > 1 || authorizationOccurrences > 1 || (apiKey && authorization)) {
      reject(res, 401, 'Ambiguous credentials');
      return;
    }
    if ((!apiKey || !API_KEY_PATTERN.test(apiKey))
        && (!authorization || !BEARER_PATTERN.test(authorization))) {
      reject(res, 401, 'Valid credential header required');
      return;
    }

    const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : '';
    if (!/^application\/json(?:;|$)/i.test(contentType)) {
      reject(res, 415, 'Content-Type must be application/json');
      return;
    }
    if (rawHeaderCount(req, 'content-length') > 1) {
      reject(res, 400, 'Ambiguous Content-Length');
      return;
    }
    const contentLengthHeader = req.headers['content-length'];
    const contentLength = contentLengthHeader === undefined ? undefined : Number(contentLengthHeader);
    if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
      reject(res, 400, 'Invalid Content-Length');
      return;
    }
    if (contentLength !== undefined && contentLength > MAX_JSON_BYTES) {
      reject(res, 413, 'Request body is too large');
      return;
    }

    const now = Date.now();
    if (now - windowStartedAt >= 60_000) {
      windowStartedAt = now;
      requests = 0;
      largeBodies = 0;
      reservedBytes = 0;
    }
    const transferEncoding = typeof req.headers['transfer-encoding'] === 'string'
      ? req.headers['transfer-encoding'].toLowerCase()
      : '';
    const unknownLength = contentLength === undefined || transferEncoding.includes('chunked');
    const reservation = unknownLength ? MAX_JSON_BYTES : contentLength;
    const large = unknownLength || reservation > LARGE_BODY_BYTES;
    requests++;
    reservedBytes += reservation;
    if (large) largeBodies++;
    if (requests > requestLimit || largeBodies > largeBodyLimit || reservedBytes > byteLimit) {
      res.setHeader('Retry-After', '60');
      reject(res, 429, 'Too many unauthenticated requests');
      return;
    }
    next();
  };
}
