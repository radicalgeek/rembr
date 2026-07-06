/**
 * MCP Header Validation Middleware (SEP-2243)
 *
 * Validates Mcp-Method and Mcp-Name headers on Streamable HTTP POST requests.
 * Per SEP-2243, servers must reject requests where headers disagree with
 * the JSON-RPC body method.
 *
 * Behaviour:
 *   - POST /mcp requests must carry Mcp-Method and/or Mcp-Name headers
 *   - Mcp-Method must match the JSON-RPC body "method" field
 *   - Mcp-Name (when present) must match the JSON-RPC body "method" field
 *   - GET /mcp and DELETE /mcp are exempt (no body method to validate)
 *   - Mismatch → 400 Bad Request with JSON-RPC error
 *
 * Usage:
 *   app.use('/mcp', mcpHeaderValidationMiddleware);
 *   app.post('/mcp', mcpHandler);
 *
 * Note: This middleware runs BEFORE JSON-RPC body parsing, so it only reads
 * the raw body for the "method" field. It must be placed before
 * express.json() or any body-parser that consumes the stream.
 */

import type { Request, Response, NextFunction } from 'express';

/**
 * Header names used for MCP method validation.
 */
export const MCP_METHOD_HEADER = 'mcp-method';
export const MCP_NAME_HEADER = 'mcp-name';

/**
 * JSON-RPC error code for invalid parameters.
 */
const INVALID_PARAMS = -32602;

/**
 * Express middleware that validates MCP method headers against the JSON-RPC body.
 *
 * This must be applied before body-parser middleware so the raw body is available.
 * For GET and DELETE requests (which have no body method), this middleware is a no-op.
 */
export function mcpHeaderValidationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // GET and DELETE on /mcp have no body method to validate
  if (req.method !== 'POST') {
    next();
    return;
  }

  const mcpMethod = req.headers[MCP_METHOD_HEADER] as string | undefined;
  const mcpName = req.headers[MCP_NAME_HEADER] as string | undefined;

  // If neither header is present, allow the request through
  // (clients may rely on URL/path for method routing)
  if (!mcpMethod && !mcpName) {
    next();
    return;
  }

  // Extract method from parsed body (express.json() must have run)
  const bodyMethod = (req.body?.method as string | undefined);

  // If body has no method field, we cannot validate — allow through
  // (will be caught by JSON-RPC parser later if needed)
  if (!bodyMethod) {
    next();
    return;
  }

  // Validate Mcp-Method against body method
  if (mcpMethod && mcpMethod !== bodyMethod) {
    res.status(400).json({
      error: {
        code: INVALID_PARAMS,
        message: `Mcp-Method header "${mcpMethod}" does not match body method "${bodyMethod}"`,
      },
      id: req.body?.id,
    });
    return;
  }

  // Validate Mcp-Name against body method (if present)
  if (mcpName && mcpName !== bodyMethod) {
    res.status(400).json({
      error: {
        code: INVALID_PARAMS,
        message: `Mcp-Name header "${mcpName}" does not match body method "${bodyMethod}"`,
      },
      id: req.body?.id,
    });
    return;
  }

  next();
}
