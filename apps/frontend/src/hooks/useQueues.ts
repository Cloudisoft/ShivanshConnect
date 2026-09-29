import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/apiClient';

export interface OutboundQueue {
  campaign_id: string;
  name: string;
  status: string;
  concurrency_limit: number | null;
  waiting_now: number;
  scheduled_later: number;
  on_call: number;
}

export interface QueuedCallback {
  id: string;
  lead_id: string;
  campaign_id: string | null;
  phone_e164: string;
  scheduled_at: string;
  timezone: string;
  status: string;
  reason: string | null;
  assigned_to: string | null;
  lead_name: string | null;
  campaign_name: string | null;
}

export interface QueueSummary {
  outbound: OutboundQueue[];
  callbacks: { due_now: number; upcoming: QueuedCallback[] };
  inbound: { on_call: number; today: number; answering_numbers: number; total_numbers: number };
}

export interface InboundRoute {
  phone_number_id: string;
  phone_number: string;
  friendly_name: string | null;
  provider_key: string;
  answering: boolean;
  assigned_campaign_id: string | null;
  answered_by_campaign: { id: string; name: string; status: string } | null;
  fallback_number: string | null;
}

/** Live queue state - refreshed every 10s while the page is open. */
export function useQueueSummary() {
  return useQuery({
    queryKey: ['queues', 'summary'],
    queryFn: () => api.get<QueueSummary>('/queues/summary'),
    refetchInterval: 10_000,
  });
}

export function useInboundRoutes() {
  return useQuery({
    queryKey: ['queues', 'inbound-routes'],
    queryFn: () => api.get<InboundRoute[]>('/queues/inbound-routes'),
  });
}

export function useUpdateInboundRoute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ phoneNumberId, campaignId }: { phoneNumberId: string; campaignId: string | null }) =>
      api.patch(`/queues/inbound-routes/${phoneNumberId}`, { assigned_campaign_id: campaignId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['queues'] }),
  });
}
