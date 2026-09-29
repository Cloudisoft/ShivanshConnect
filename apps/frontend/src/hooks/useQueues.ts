import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/apiClient';
import { readPersisted, writePersisted } from '../lib/persistedQuery';
import { useAuth } from './useAuth';

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

export interface InboundRoutesData {
  routes: InboundRoute[];
  campaigns: Array<{ id: string; name: string; status: string }>;
}

// Both pages paint the last data this user saw straight away (marked
// stale, so it refetches immediately) instead of a loading state - same
// approach as the dashboard, see lib/persistedQuery.ts.

/** Live queue state - refreshed every 10s while the page is open. */
export function useQueueSummary() {
  const ownerId = useAuth().me?.user.id;
  return useQuery({
    queryKey: ['queues', 'summary'],
    queryFn: async () => {
      const data = await api.get<QueueSummary>('/queues/summary');
      writePersisted('queues:summary', ownerId, data);
      return data;
    },
    initialData: () => readPersisted<QueueSummary>('queues:summary', ownerId),
    initialDataUpdatedAt: 0,
    refetchInterval: 10_000,
  });
}

export function useInboundRoutes() {
  const ownerId = useAuth().me?.user.id;
  return useQuery({
    queryKey: ['queues', 'inbound-routes'],
    queryFn: async () => {
      const data = await api.get<InboundRoutesData>('/queues/inbound-routes');
      writePersisted('queues:inbound-routes', ownerId, data);
      return data;
    },
    initialData: () => readPersisted<InboundRoutesData>('queues:inbound-routes', ownerId),
    initialDataUpdatedAt: 0,
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
