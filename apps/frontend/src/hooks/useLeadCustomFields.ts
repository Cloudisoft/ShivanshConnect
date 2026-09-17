import { useQuery } from '@tanstack/react-query';
import type { LeadCustomField } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

export function useLeadCustomFields() {
  return useQuery({
    queryKey: ['lead-custom-fields'],
    queryFn: () => api.get<LeadCustomField[]>('/lead-custom-fields'),
  });
}
