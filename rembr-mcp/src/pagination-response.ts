/**
 * Pagination Response Types and Utilities (REM-68)
 * 
 * Standardizes pagination metadata across all list/search operations.
 */

export interface PaginationMetadata {
  /**
   * Number of items returned in this response
   */
  returned: number;

  /**
   * Total number of items available (before pagination)
   */
  total_available: number;

  /**
   * Query execution time in milliseconds
   */
  execution_time_ms: number;
}

export interface PaginationInfo {
  /**
   * Whether more results are available beyond this page
   */
  has_more: boolean;

  /**
   * Suggested filters to narrow down results when truncated
   */
  suggested_filters?: string[];
}

export interface PaginatedResponse<T> {
  /**
   * Operation success status
   */
  success: boolean;

  /**
   * Response data (array for list operations, single item for get operations)
   */
  data: T;

  /**
   * Pagination metadata
   */
  metadata: PaginationMetadata;

  /**
   * Pagination information
   */
  pagination?: PaginationInfo;

  /**
   * Related tools that might be useful
   */
  related_tools?: string[];

  /**
   * Error message (if success: false)
   */
  error?: string;
}

export interface PaginationOptions {
  /**
   * Maximum items to return (limit)
   */
  limit?: number;

  /**
   * Offset for pagination
   */
  offset?: number;

  /**
   * Filter suggestions when results are truncated
   */
  suggested_filters?: string[];

  /**
   * Related tools to include in response
   */
  related_tools?: string[];
}

/**
 * Wrap a list/search response with pagination metadata
 */
export function createPaginatedResponse<T>(
  data: T[],
  totalAvailable: number,
  executionTimeMs: number,
  options: PaginationOptions = {}
): PaginatedResponse<T[]> {
  const { limit, offset = 0, suggested_filters, related_tools } = options;

  const returned = data.length;
  const hasMore = limit !== undefined && totalAvailable > offset + returned;

  return {
    success: true,
    data,
    metadata: {
      returned,
      total_available: totalAvailable,
      execution_time_ms: executionTimeMs,
    },
    pagination: {
      has_more: hasMore,
      ...(suggested_filters && suggested_filters.length > 0 && { suggested_filters }),
    },
    ...(related_tools && related_tools.length > 0 && { related_tools }),
  };
}

/**
 * Wrap a single-item response (get operations)
 */
export function createSingleItemResponse<T>(
  data: T,
  executionTimeMs: number,
  relatedTools?: string[]
): PaginatedResponse<T> {
  return {
    success: true,
    data,
    metadata: {
      returned: 1,
      total_available: 1,
      execution_time_ms: executionTimeMs,
    },
    ...(relatedTools && relatedTools.length > 0 && { related_tools: relatedTools }),
  };
}

/**
 * Create an error response
 */
export function createErrorResponse<T>(
  error: string,
  executionTimeMs: number
): PaginatedResponse<T> {
  return {
    success: false,
    data: null as T,
    metadata: {
      returned: 0,
      total_available: 0,
      execution_time_ms: executionTimeMs,
    },
    error,
  };
}

/**
 * Timing utility for measuring execution time
 */
export class Timer {
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  elapsed(): number {
    return Date.now() - this.startTime;
  }
}

/**
 * Generate suggested filters based on truncation
 */
export function generateSuggestedFilters(
  totalAvailable: number,
  limit: number,
  availableFilters: Record<string, string[]>
): string[] {
  if (totalAvailable <= limit) {
    return [];
  }

  const suggestions: string[] = [];

  // Suggest category filters if available
  if (availableFilters.categories && availableFilters.categories.length > 0) {
    suggestions.push(`category: '${availableFilters.categories[0]}'`);
  }

  // Suggest date range if available
  if (availableFilters.dateRanges && availableFilters.dateRanges.length > 0) {
    suggestions.push(`date: '${availableFilters.dateRanges[0]}'`);
  }

  // Suggest tag filters if available
  if (availableFilters.tags && availableFilters.tags.length > 0) {
    suggestions.push(`tag: '${availableFilters.tags[0]}'`);
  }

  return suggestions;
}
