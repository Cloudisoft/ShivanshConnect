import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ImportJob, ImportJobRow } from '@shivanshconnect/shared';
import { api, ApiClientError } from '../lib/apiClient';
import { supabase } from '../lib/supabaseClient';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api/v1';

export function useImportJob(id: string | undefined, opts: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: ['import-jobs', id],
    queryFn: () => api.get<ImportJob>(`/import-jobs/${id}`),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      if (!opts.poll) return false;
      const status = query.state.data?.status;
      return status && ['pending', 'parsing', 'validating', 'committing'].includes(status) ? 1000 : false;
    },
  });
}

export function useImportJobRows(id: string | undefined, result?: string) {
  const params = new URLSearchParams();
  if (result) params.set('result', result);
  return useQuery({
    queryKey: ['import-jobs', id, 'rows', result ?? 'all'],
    queryFn: () => api.get<ImportJobRow[]>(`/import-jobs/${id}/rows?${params.toString()}`),
    enabled: Boolean(id),
  });
}

/** Uploads a file as multipart/form-data - the one call in this app that
 * can't go through lib/apiClient's JSON-only request(), since it needs a
 * real multipart body instead of application/json. */
export function useUploadImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadListId, file }: { leadListId: string; file: File }) => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch(`${API_BASE_URL}/lead-lists/${leadListId}/import`, {
        method: 'POST',
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
        body: formData,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) {
        throw new ApiClientError(
          res.status,
          body?.error?.code ?? 'UNKNOWN_ERROR',
          body?.error?.message ?? 'Could not upload this file.',
          body?.error?.details,
        );
      }
      return body.data as ImportJob;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['import-jobs'] }),
  });
}

export function useUpdateImportMapping() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, column_mapping }: { id: string; column_mapping: Record<string, string> }) =>
      api.patch<ImportJob>(`/import-jobs/${id}/mapping`, { column_mapping }),
    onSuccess: (_data, variables) => queryClient.invalidateQueries({ queryKey: ['import-jobs', variables.id] }),
  });
}

export function useCommitImportJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<ImportJob>(`/import-jobs/${id}/commit`),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['import-jobs', id] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['lead-lists'] });
    },
  });
}

export async function downloadImportErrors(id: string): Promise<void> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const res = await fetch(`${API_BASE_URL}/import-jobs/${id}/errors`, {
    headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
  });
  if (!res.ok) throw new Error('Could not download the error report.');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `import-${id}-errors.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
