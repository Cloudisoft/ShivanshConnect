import { useQuery } from '@tanstack/react-query';
import type { AgentAnalytics, AnalyticsPeriod, CampaignAnalytics, DashboardCharts, DashboardMetrics } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

export interface PeriodFilterValue {
  period: AnalyticsPeriod;
  date_from?: string;
  date_to?: string;
}

function periodParams(value: PeriodFilterValue): string {
  const params = new URLSearchParams({ period: value.period });
  if (value.period === 'custom') {
    if (value.date_from) params.set('date_from', value.date_from);
    if (value.date_to) params.set('date_to', value.date_to);
  }
  return params.toString();
}

export function useDashboardMetrics(period: PeriodFilterValue) {
  return useQuery({
    queryKey: ['dashboard', 'metrics', period],
    queryFn: () => api.get<DashboardMetrics>(`/dashboard?${periodParams(period)}`),
    refetchInterval: 30_000,
  });
}

export function useDashboardCharts(period: PeriodFilterValue) {
  return useQuery({
    queryKey: ['dashboard', 'charts', period],
    queryFn: () => api.get<DashboardCharts>(`/dashboard/charts?${periodParams(period)}`),
    refetchInterval: 60_000,
  });
}

export function useCampaignAnalytics(campaignId: string | undefined, period: PeriodFilterValue) {
  return useQuery({
    queryKey: ['analytics', 'campaign', campaignId, period],
    queryFn: () => api.get<CampaignAnalytics>(`/analytics/campaigns/${campaignId}?${periodParams(period)}`),
    enabled: Boolean(campaignId),
  });
}

export function useAgentAnalytics(period: PeriodFilterValue) {
  return useQuery({
    queryKey: ['analytics', 'agents', period],
    queryFn: () => api.get<AgentAnalytics[]>(`/analytics/agents?${periodParams(period)}`),
  });
}
