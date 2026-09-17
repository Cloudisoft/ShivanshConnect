import type { ApiResponse, PaginationMeta } from '@shivanshconnect/shared';
import { supabase } from './supabaseClient';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api/v1';

export class ApiClientError extends Error {
  code: string;
  status: number;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (session?.access_token) {
    headers.set('Authorization', `Bearer ${session.access_token}`);
  }

  const res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => null)) as ApiResponse<T> | null;

  if (!res.ok || !body || !body.success) {
    throw new ApiClientError(
      res.status,
      body?.error?.code ?? 'UNKNOWN_ERROR',
      body?.error?.message ?? body?.message ?? 'Something went wrong. Please try again.',
      body?.error?.details,
    );
  }

  return body.data as T;
}

async function requestWithMeta<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ data: T; pagination?: PaginationMeta }> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (session?.access_token) {
    headers.set('Authorization', `Bearer ${session.access_token}`);
  }

  const res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => null)) as ApiResponse<T> | null;

  if (!res.ok || !body || !body.success) {
    throw new ApiClientError(
      res.status,
      body?.error?.code ?? 'UNKNOWN_ERROR',
      body?.error?.message ?? body?.message ?? 'Something went wrong. Please try again.',
      body?.error?.details,
    );
  }

  return { data: body.data as T, pagination: body.pagination };
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  getPage: <T>(path: string) => requestWithMeta<T>(path, { method: 'GET' }),
  post: <T>(path: string, payload?: unknown) =>
    request<T>(path, { method: 'POST', body: payload !== undefined ? JSON.stringify(payload) : undefined }),
  patch: <T>(path: string, payload?: unknown) =>
    request<T>(path, { method: 'PATCH', body: payload !== undefined ? JSON.stringify(payload) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
