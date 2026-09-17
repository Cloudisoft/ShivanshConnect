/**
 * Standard API response envelope used by every ShivanshConnect backend endpoint.
 * See master spec section 78.
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T | null;
  error: ApiError | null;
  message: string | null;
  pagination?: PaginationMeta;
  request_id: string;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface PaginationParams {
  page?: number;
  page_size?: number;
}

export interface PaginationMeta {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}
