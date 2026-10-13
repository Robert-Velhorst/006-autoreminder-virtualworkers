/**
 * Pagination Utility
 * Provides consistent pagination across API endpoints
 */

export interface PaginationParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginationResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export interface PaginationOptions {
  defaultLimit?: number;
  maxLimit?: number;
  defaultSortBy?: string;
  defaultSortOrder?: 'asc' | 'desc';
}

export interface LimitOffsetOptions {
  defaultLimit?: number;
  maxLimit?: number;
}

/** Parse offset pagination without allowing a caller to request an unbounded read. */
export function parseLimitOffset(
  query: { limit?: unknown; offset?: unknown },
  options: LimitOffsetOptions = {},
): { limit: number; offset: number } {
  const defaultLimit = options.defaultLimit ?? 50;
  const maxLimit = options.maxLimit ?? 100;
  const requestedLimit = Number.parseInt(String(query.limit ?? ""), 10);
  const requestedOffset = Number.parseInt(String(query.offset ?? ""), 10);

  return {
    limit: Math.min(maxLimit, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : defaultLimit)),
    offset: Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : 0),
  };
}

/**
 * Parse pagination parameters from request query
 */
export function parsePaginationParams(
  query: any,
  options: PaginationOptions = {}
): Required<PaginationParams> {
  const {
    defaultLimit = 50,
    maxLimit = 100,
    defaultSortBy = 'createdAt',
    defaultSortOrder = 'desc',
  } = options;

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(
    maxLimit,
    Math.max(1, parseInt(query.limit, 10) || defaultLimit)
  );
  const sortBy = query.sortBy || defaultSortBy;
  const sortOrder = query.sortOrder === 'asc' ? 'asc' : defaultSortOrder;

  return {
    page,
    limit,
    sortBy,
    sortOrder,
  };
}

/**
 * Calculate pagination metadata
 */
export function calculatePagination(
  page: number,
  limit: number,
  total: number
) {
  const totalPages = Math.ceil(total / limit);
  const hasNext = page < totalPages;
  const hasPrev = page > 1;

  return {
    page,
    limit,
    total,
    totalPages,
    hasNext,
    hasPrev,
  };
}

/**
 * Create paginated response
 */
export function createPaginatedResponse<T>(
  data: T[],
  page: number,
  limit: number,
  total: number
): PaginationResult<T> {
  return {
    data,
    pagination: calculatePagination(page, limit, total),
  };
}

/**
 * Calculate offset for SQL queries
 */
export function calculateOffset(page: number, limit: number): number {
  return (page - 1) * limit;
}

/**
 * Paginate array in memory (for small datasets)
 */
export function paginateArray<T>(
  array: T[],
  page: number,
  limit: number
): PaginationResult<T> {
  const offset = calculateOffset(page, limit);
  const data = array.slice(offset, offset + limit);
  
  return createPaginatedResponse(data, page, limit, array.length);
}

/**
 * Generate pagination links for API responses
 */
export function generatePaginationLinks(
  baseUrl: string,
  page: number,
  limit: number,
  total: number
): {
  first: string;
  prev: string | null;
  next: string | null;
  last: string;
} {
  const totalPages = Math.ceil(total / limit);
  
  const buildUrl = (p: number) => `${baseUrl}?page=${p}&limit=${limit}`;
  
  return {
    first: buildUrl(1),
    prev: page > 1 ? buildUrl(page - 1) : null,
    next: page < totalPages ? buildUrl(page + 1) : null,
    last: buildUrl(totalPages),
  };
}
