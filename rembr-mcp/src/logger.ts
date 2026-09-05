/**
 * Structured Logger for Loki Integration
 * 
 * Provides JSON-formatted logging with proper labels and fields for Grafana Loki ingestion.
 * All logs are output to stdout in JSON format for container log collection.
 */

import { toolSchemas } from './schemas.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SAFE_CONTEXT_KEYS = new Set([
  'correlationId', 'tool', 'operation', 'category', 'transport', 'searchMode',
  'resultCount', 'errorType', 'status', 'count', 'durationMs',
]);
const SAFE_OPERATIONS = new Set(['authentication', 'http_request', 'database_query', 'optimization']);
const KNOWN_TOOLS = new Set(Object.keys(toolSchemas));

function sanitiseLogContext(context?: LogContext): LogContext | undefined {
  if (!context) return undefined;
  const safe: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (!SAFE_CONTEXT_KEYS.has(key)) continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value;
    } else if (typeof value === 'string') {
      safe[key] = value.slice(0, 100).replace(/[\r\n]/g, ' ');
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export interface LogContext {
  tenantId?: string;
  projectId?: string;
  userId?: string;
  sessionId?: string;
  correlationId?: string;
  tool?: string;
  operation?: string;
  [key: string]: any;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  error?: {
    message: string;
    type: string;
    stack?: string;
    code?: string;
  };
  metrics?: Record<string, number>;
  labels?: Record<string, string>;
}

class StructuredLogger {
  private serviceName: string = 'rembr-mcp';
  private environment: string = process.env.NODE_ENV || 'development';
  private version: string = process.env.APP_VERSION || '1.0.0';

  /**
   * Create a structured log entry
   */
  private createLogEntry(
    level: LogLevel,
    message: string,
    context?: LogContext,
    error?: Error,
    metrics?: Record<string, number>
  ): LogEntry {
    const safeContext = sanitiseLogContext(context);
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      labels: {
        service: this.serviceName,
        environment: this.environment,
        version: this.version,
        ...(safeContext?.tool && { tool_name: safeContext.tool }),
        ...(safeContext?.operation && SAFE_OPERATIONS.has(safeContext.operation) && { operation: safeContext.operation })
      }
    };

    if (safeContext) {
      entry.context = safeContext;
    }

    if (error) {
      entry.error = {
        message: this.environment === 'production' ? 'Operation failed' : error.message,
        type: error.constructor.name,
        ...(this.environment !== 'production' && { stack: error.stack }),
        code: (error as any).code
      };
    }

    if (metrics) {
      entry.metrics = metrics;
    }

    return entry;
  }

  /**
   * Output log entry to stdout in JSON format
   */
  private output(entry: LogEntry): void {
    // For development, also output human-readable format
    if (this.environment === 'development') {
      const emoji = {
        debug: '🔍',
        info: 'ℹ️',
        warn: '⚠️',
        error: '❌'
      }[entry.level];
      
      console.error(`${emoji} [${entry.level.toUpperCase()}] ${entry.message}`, 
        entry.context ? `\n  Context: ${JSON.stringify(entry.context, null, 2)}` : '',
        entry.error ? `\n  Error: ${entry.error.message}` : ''
      );
    }

    // Always output JSON for Loki
    console.log(JSON.stringify(entry));
  }

  /**
   * Log debug message
   */
  debug(message: string, context?: LogContext, metrics?: Record<string, number>): void {
    const entry = this.createLogEntry('debug', message, context, undefined, metrics);
    this.output(entry);
  }

  /**
   * Log info message
   */
  info(message: string, context?: LogContext, metrics?: Record<string, number>): void {
    const entry = this.createLogEntry('info', message, context, undefined, metrics);
    this.output(entry);
  }

  /**
   * Log warning message
   */
  warn(message: string, context?: LogContext, metrics?: Record<string, number>): void {
    const entry = this.createLogEntry('warn', message, context, undefined, metrics);
    this.output(entry);
  }

  /**
   * Log error message
   */
  error(message: string, error?: Error, context?: LogContext): void {
    const entry = this.createLogEntry('error', message, context, error);
    this.output(entry);
  }

  /**
   * Log MCP tool execution
   */
  mcpTool(
    toolName: string,
    status: 'start' | 'success' | 'error',
    context?: LogContext,
    durationMs?: number,
    error?: Error
  ): void {
    const safeToolName = KNOWN_TOOLS.has(toolName) ? toolName : 'unknown';
    const message = `MCP tool ${safeToolName} ${status}`;
    const logContext = { ...context, tool: safeToolName };
    const metrics = durationMs ? { duration_ms: durationMs } : undefined;

    if (status === 'error' && error) {
      this.error(message, error, logContext);
    } else {
      this.info(message, logContext, metrics);
    }
  }

  /**
   * Log HTTP request
   */
  httpRequest(
    method: string,
    path: string,
    statusCode: number,
    durationMs: number,
    context?: LogContext
  ): void {
    this.info(`HTTP ${method} ${path} - ${statusCode}`, {
      ...context,
      operation: 'http_request'
    }, {
      status_code: statusCode,
      duration_ms: durationMs
    });
  }

  /**
   * Log authentication attempt
   */
  auth(
    method: 'api_key' | 'oauth',
    status: 'success' | 'error',
    context?: LogContext,
    error?: Error
  ): void {
    const message = `Authentication ${method} ${status}`;
    const logContext = { ...context, operation: 'authentication' };

    if (status === 'error' && error) {
      this.error(message, error, logContext);
    } else {
      this.info(message, logContext);
    }
  }

  /**
   * Log database query
   */
  dbQuery(
    queryType: string,
    durationMs: number,
    context?: LogContext,
    error?: Error
  ): void {
    if (error) {
      this.error(`Database query ${queryType} failed`, error, {
        ...context,
        operation: 'database_query'
      });
    } else {
      this.debug(`Database query ${queryType}`, {
        ...context,
        operation: 'database_query'
      }, {
        duration_ms: durationMs
      });
    }
  }

  /**
   * Log optimization cycle
   */
  optimization(
    type: string,
    status: 'start' | 'complete' | 'error',
    context?: LogContext,
    metrics?: Record<string, number>,
    error?: Error
  ): void {
    const message = `Optimization ${type} ${status}`;
    const logContext = { ...context, operation: 'optimization' };

    if (status === 'error' && error) {
      this.error(message, error, logContext);
    } else {
      this.info(message, logContext, metrics);
    }
  }
}

// Export singleton instance
export const logger = new StructuredLogger();

// Export factory for custom loggers
export function createLogger(serviceName?: string): StructuredLogger {
  const customLogger = new StructuredLogger();
  if (serviceName) {
    (customLogger as any).serviceName = serviceName;
  }
  return customLogger;
}
