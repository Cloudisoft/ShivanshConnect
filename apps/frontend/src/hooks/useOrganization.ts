import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Organization } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

type OrgWithSettings = Organization & { settings: Record<string, unknown> };

export function useOrganization() {
  return useQuery({
    queryKey: ['organization'],
    queryFn: () => api.get<OrgWithSettings>('/organizations/me'),
  });
}

export function useUpdateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; timezone?: string; settings?: Record<string, unknown> }) =>
      api.patch<OrgWithSettings>('/organizations/me', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization'] });
      queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
}
