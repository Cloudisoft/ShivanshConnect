import { randomUUID } from 'node:crypto';
import type { ApiResponse, PaginationMeta } from '@shivanshconnect/shared';

export function ok<T>(
  data: T,
  opts: { message?: string; pagination?: PaginationMeta; requestId?: string } = {},
): ApiResponse<T> {
  return {
    success: true,
    data,
    error: null,
    message: opts.message ?? null,
    pagination: opts.pagination,
    request_id: opts.requestId ?? randomUUID(),
  };
}

export function fail(
  code: string,
  message: string,
  opts: { details?: unknown; requestId?: string } = {},
): ApiResponse<null> {
  return {
    success: false,
    data: null,
    error: { code, message, details: opts.details },
    message,
    request_id: opts.requestId ?? randomUUID(),
  };
}

export function paginationMeta(page: number, pageSize: number, total: number): PaginationMeta {
  return {
    page,
    page_size: pageSize,
    total,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
