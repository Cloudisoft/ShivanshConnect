import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EmailCampaign, EmailMessage, MessagingCounts, SmsCampaign, SmsMessage, SmtpSettings } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

// ---------------------------------------------------------------------
// SMTP settings
// ---------------------------------------------------------------------
export function useSmtpSettings() {
  return useQuery({ queryKey: ['smtp-settings'], queryFn: () => api.get<SmtpSettings | null>('/settings/smtp') });
}

export function useSaveSmtpSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.post<SmtpSettings>('/settings/smtp', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['smtp-settings'] }),
  });
}

export function useTestSmtpSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (recipient: string) => api.post<{ success: boolean; error: string | null; settings: SmtpSettings }>('/settings/smtp/test', { recipient }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['smtp-settings'] }),
  });
}

// ---------------------------------------------------------------------
// SMS campaigns
// ---------------------------------------------------------------------
export type SmsCampaignWithCounts = SmsCampaign & { counts: MessagingCounts };

export function useSmsCampaigns(page = 1, pageSize = 20, status?: string) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (status) params.set('status', status);
  return useQuery({
    queryKey: ['sms-campaigns', page, pageSize, status ?? ''],
    queryFn: () => api.getPage<SmsCampaignWithCounts[]>(`/sms-campaigns?${params.toString()}`),
  });
}

export function useSmsCampaign(id: string | undefined) {
  return useQuery({
    queryKey: ['sms-campaigns', id],
    queryFn: () => api.get<SmsCampaignWithCounts>(`/sms-campaigns/${id}`),
    enabled: Boolean(id),
    refetchInterval: 5000,
  });
}

function invalidateSms(queryClient: ReturnType<typeof useQueryClient>, id?: string) {
  queryClient.invalidateQueries({ queryKey: ['sms-campaigns'] });
  if (id) queryClient.invalidateQueries({ queryKey: ['sms-campaigns', id] });
}

export function useCreateSmsCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.post<SmsCampaign>('/sms-campaigns', input),
    onSuccess: () => invalidateSms(queryClient),
  });
}

export function useUpdateSmsCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Record<string, unknown>) => api.patch<SmsCampaign>(`/sms-campaigns/${id}`, input),
    onSuccess: (_d, v) => invalidateSms(queryClient, v.id),
  });
}

export function useDeleteSmsCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/sms-campaigns/${id}`),
    onSuccess: () => invalidateSms(queryClient),
  });
}

export function useSmsCampaignLifecycleAction(action: 'start' | 'pause' | 'resume' | 'cancel') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<SmsCampaign>(`/sms-campaigns/${id}/${action}`),
    onSuccess: (_d, id) => invalidateSms(queryClient, id),
  });
}

export function useSmsMessages(campaignId: string | undefined, page = 1, pageSize = 50, status?: string) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (status) params.set('status', status);
  return useQuery({
    queryKey: ['sms-campaigns', campaignId, 'messages', page, pageSize, status ?? ''],
    queryFn: () => api.getPage<SmsMessage[]>(`/sms-campaigns/${campaignId}/messages?${params.toString()}`),
    enabled: Boolean(campaignId),
    refetchInterval: 5000,
  });
}

// ---------------------------------------------------------------------
// Email campaigns
// ---------------------------------------------------------------------
export type EmailCampaignWithCounts = EmailCampaign & { counts: MessagingCounts };

export function useEmailCampaigns(page = 1, pageSize = 20, status?: string) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (status) params.set('status', status);
  return useQuery({
    queryKey: ['email-campaigns', page, pageSize, status ?? ''],
    queryFn: () => api.getPage<EmailCampaignWithCounts[]>(`/email-campaigns?${params.toString()}`),
  });
}

export function useEmailCampaign(id: string | undefined) {
  return useQuery({
    queryKey: ['email-campaigns', id],
    queryFn: () => api.get<EmailCampaignWithCounts>(`/email-campaigns/${id}`),
    enabled: Boolean(id),
    refetchInterval: 5000,
  });
}

function invalidateEmail(queryClient: ReturnType<typeof useQueryClient>, id?: string) {
  queryClient.invalidateQueries({ queryKey: ['email-campaigns'] });
  if (id) queryClient.invalidateQueries({ queryKey: ['email-campaigns', id] });
}

export function useCreateEmailCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.post<EmailCampaign>('/email-campaigns', input),
    onSuccess: () => invalidateEmail(queryClient),
  });
}

export function useUpdateEmailCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Record<string, unknown>) => api.patch<EmailCampaign>(`/email-campaigns/${id}`, input),
    onSuccess: (_d, v) => invalidateEmail(queryClient, v.id),
  });
}

export function useDeleteEmailCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/email-campaigns/${id}`),
    onSuccess: () => invalidateEmail(queryClient),
  });
}

export function useEmailCampaignLifecycleAction(action: 'start' | 'pause' | 'resume' | 'cancel') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<EmailCampaign>(`/email-campaigns/${id}/${action}`),
    onSuccess: (_d, id) => invalidateEmail(queryClient, id),
  });
}

export function useEmailMessages(campaignId: string | undefined, page = 1, pageSize = 50, status?: string) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (status) params.set('status', status);
  return useQuery({
    queryKey: ['email-campaigns', campaignId, 'messages', page, pageSize, status ?? ''],
    queryFn: () => api.getPage<EmailMessage[]>(`/email-campaigns/${campaignId}/messages?${params.toString()}`),
    enabled: Boolean(campaignId),
    refetchInterval: 5000,
  });
}
