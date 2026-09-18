import { useState, type FormEvent } from 'react';
import { MessageSquare, Plus, Mail } from 'lucide-react';
import type { MessagingCampaignStatus } from '@shivanshconnect/shared';
import { useAuth } from '../hooks/useAuth';
import { usePhoneNumbers } from '../hooks/usePhoneNumbers';
import { useLeadLists } from '../hooks/useLeadLists';
import {
  useCreateEmailCampaign,
  useCreateSmsCampaign,
  useEmailCampaignLifecycleAction,
  useEmailCampaigns,
  useEmailMessages,
  useSmsCampaignLifecycleAction,
  useSmsCampaigns,
  useSmsMessages,
  type EmailCampaignWithCounts,
  type SmsCampaignWithCounts,
} from '../hooks/useMessaging';
import { Alert, Badge, Button, Card, Input, Label } from '../components/ui';
import { VariablePalette } from '../components/VariablePalette';
import { ExportTrigger } from '../components/exports/ExportTrigger';
import { useQueueEmailMessagesExport, useQueueSmsMessagesExport } from '../hooks/useExports';
import { ApiClientError } from '../lib/apiClient';

const STATUS_TONE: Record<MessagingCampaignStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  scheduled: 'warning',
  sending: 'success',
  paused: 'warning',
  completed: 'neutral',
  cancelled: 'danger',
  failed: 'danger',
};

export function MessagingPage(): JSX.Element {
  const [tab, setTab] = useState<'sms' | 'email'>('sms');

  return (
    <div>
      <div>
        <h1 className="text-2xl font-semibold text-ink-900">Messaging</h1>
        <p className="mt-1 text-sm text-ink-500">SMS and email campaigns, with real throttled, DNC/opt-out-aware sending.</p>
      </div>

      <div className="mt-6 flex gap-1 border-b border-ink-200">
        <button
          className={`px-4 py-2 text-sm font-medium ${tab === 'sms' ? 'border-b-2 border-ink-900 text-ink-900' : 'text-ink-500'}`}
          onClick={() => setTab('sms')}
        >
          <MessageSquare className="mr-1.5 inline h-4 w-4" /> SMS Campaigns
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium ${tab === 'email' ? 'border-b-2 border-ink-900 text-ink-900' : 'text-ink-500'}`}
          onClick={() => setTab('email')}
        >
          <Mail className="mr-1.5 inline h-4 w-4" /> Email Campaigns
        </button>
      </div>

      <div className="mt-6">{tab === 'sms' ? <SmsCampaignsTab /> : <EmailCampaignsTab />}</div>
    </div>
  );
}

// ---------------------------------------------------------------------
// SMS
// ---------------------------------------------------------------------
function SmsCampaignsTab(): JSX.Element {
  const { hasPermission } = useAuth();
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const campaignsQuery = useSmsCampaigns();
  const campaigns = campaignsQuery.data?.data ?? [];
  const canManage = hasPermission('messaging.manage');

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-500">Send templated SMS blasts to a lead list through your connected Twilio/Telnyx number.</p>
        {canManage && (
          <Button onClick={() => setShowCreate((v) => !v)}>
            <Plus className="h-4 w-4" /> New SMS campaign
          </Button>
        )}
      </div>

      {showCreate && <CreateSmsCampaignForm onClose={() => setShowCreate(false)} />}

      {campaignsQuery.isLoading && <p className="mt-8 text-sm text-ink-500">Loading campaigns...</p>}

      {!campaignsQuery.isLoading && campaigns.length === 0 && (
        <Card className="mt-8 flex flex-col items-center justify-center py-16 text-center">
          <MessageSquare className="h-10 w-10 text-ink-300" />
          <p className="mt-3 text-sm font-medium text-ink-700">No SMS campaigns yet</p>
        </Card>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {campaigns.map((c) => (
          <SmsCampaignCard key={c.id} campaign={c} selected={selectedId === c.id} onToggle={() => setSelectedId(selectedId === c.id ? null : c.id)} />
        ))}
      </div>

      {selectedId && <SmsMessagesPanel campaignId={selectedId} />}
    </div>
  );
}

function SmsCampaignCard({ campaign, selected, onToggle }: { campaign: SmsCampaignWithCounts; selected: boolean; onToggle: () => void }): JSX.Element {
  const { hasPermission } = useAuth();
  const start = useSmsCampaignLifecycleAction('start');
  const pause = useSmsCampaignLifecycleAction('pause');
  const resume = useSmsCampaignLifecycleAction('resume');
  const cancel = useSmsCampaignLifecycleAction('cancel');
  const busy = start.isPending || pause.isPending || resume.isPending || cancel.isPending;
  const counts = campaign.counts;

  return (
    <Card className={selected ? 'flex flex-col gap-3 ring-2 ring-ink-900' : 'flex flex-col gap-3'}>
      <div className="flex items-start justify-between gap-2">
        <button className="min-w-0 truncate text-left text-sm font-semibold text-ink-900 hover:underline" onClick={onToggle}>
          {campaign.name}
        </button>
        <Badge tone={STATUS_TONE[campaign.status]}>{campaign.status}</Badge>
      </div>
      <p className="truncate text-xs text-ink-500">{campaign.message_template}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-ink-500">
        <span>Queued: {counts.queued}</span>
        <span>Sent: {counts.sent}</span>
        <span>Delivered: {counts.delivered}</span>
        <span>Failed: {counts.failed}</span>
        <span>Replied: {counts.replied}</span>
        <span>Total: {counts.total}</span>
      </div>
      {hasPermission('messaging.manage') && (
        <div className="flex flex-wrap gap-2 border-t border-ink-100 pt-3">
          {['draft', 'scheduled', 'paused'].includes(campaign.status) && (
            <Button variant="secondary" disabled={busy} onClick={() => (campaign.status === 'paused' ? resume : start).mutate(campaign.id)}>
              {campaign.status === 'paused' ? 'Resume' : 'Start'}
            </Button>
          )}
          {campaign.status === 'sending' && (
            <Button variant="secondary" disabled={busy} onClick={() => pause.mutate(campaign.id)}>
              Pause
            </Button>
          )}
          {['sending', 'paused', 'scheduled', 'draft'].includes(campaign.status) && (
            <Button variant="ghost" disabled={busy} onClick={() => cancel.mutate(campaign.id)}>
              Cancel
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function CreateSmsCampaignForm({ onClose }: { onClose: () => void }): JSX.Element {
  const createCampaign = useCreateSmsCampaign();
  const phoneNumbersQuery = usePhoneNumbers({ status: 'active' });
  const leadListsQuery = useLeadLists();
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('Hi {{first_name}}, ');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [leadListId, setLeadListId] = useState('');
  const [throttle, setThrottle] = useState(30);
  const [error, setError] = useState<string | null>(null);

  const smsCapableNumbers = (phoneNumbersQuery.data?.data ?? []).filter((p: any) => p.capabilities?.sms);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createCampaign.mutateAsync({ name, message_template: template, phone_number_id: phoneNumberId, lead_list_id: leadListId || undefined, throttle_per_minute: throttle });
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to create SMS campaign.');
    }
  }

  return (
    <Card className="mt-6 max-w-xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        <h2 className="text-sm font-semibold text-ink-900">New SMS campaign</h2>
        {error && <Alert>{error}</Alert>}
        <div>
          <Label htmlFor="sms-name">Name</Label>
          <Input id="sms-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </div>
        <div>
          <Label htmlFor="sms-template">Message template</Label>
          <textarea
            id="sms-template"
            className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
            rows={3}
            maxLength={1600}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            required
          />
          <VariablePalette onInsert={(token) => setTemplate((t) => `${t}${token}`)} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="sms-phone">SMS-capable number</Label>
            <select
              id="sms-phone"
              className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
              value={phoneNumberId}
              onChange={(e) => setPhoneNumberId(e.target.value)}
              required
            >
              <option value="">Select a number</option>
              {smsCapableNumbers.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.friendly_name ?? p.phone_number}
                </option>
              ))}
            </select>
            {smsCapableNumbers.length === 0 && <p className="mt-1 text-xs text-red-600">No SMS-capable numbers registered under DIDs yet.</p>}
          </div>
          <div>
            <Label htmlFor="sms-list">Lead list</Label>
            <select
              id="sms-list"
              className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
              value={leadListId}
              onChange={(e) => setLeadListId(e.target.value)}
              required
            >
              <option value="">Select a list</option>
              {(leadListsQuery.data?.data ?? []).map((l: any) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="w-40">
          <Label htmlFor="sms-throttle">Throttle (per minute)</Label>
          <Input id="sms-throttle" type="number" min={1} max={1000} value={throttle} onChange={(e) => setThrottle(Number(e.target.value))} />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={createCampaign.isPending}>
            Create draft
          </Button>
        </div>
      </form>
    </Card>
  );
}

function SmsMessagesPanel({ campaignId }: { campaignId: string }): JSX.Element {
  const { hasPermission } = useAuth();
  const messagesQuery = useSmsMessages(campaignId);
  const messages = messagesQuery.data?.data ?? [];
  const queueExport = useQueueSmsMessagesExport(campaignId);
  return (
    <Card className="mt-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink-900">Message delivery status</h3>
        {hasPermission('messaging.manage') && (
          <ExportTrigger
            csvType="sms_messages_csv"
            xlsxType="sms_messages_xlsx"
            pending={queueExport.isPending}
            onExport={(type) => queueExport.mutateAsync({ type })}
          />
        )}
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-ink-100 text-xs uppercase text-ink-400">
              <th className="py-2 pr-4">Phone</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Sent at</th>
              <th className="py-2 pr-4">Delivered at</th>
              <th className="py-2 pr-4">Error</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((m) => (
              <tr key={m.id} className="border-b border-ink-50">
                <td className="py-2 pr-4 text-ink-800">{m.phone_e164}</td>
                <td className="py-2 pr-4"><Badge tone={m.status === 'delivered' ? 'success' : m.status === 'failed' ? 'danger' : 'neutral'}>{m.status}</Badge></td>
                <td className="py-2 pr-4 text-ink-500">{m.sent_at ? new Date(m.sent_at).toLocaleString() : '—'}</td>
                <td className="py-2 pr-4 text-ink-500">{m.delivered_at ? new Date(m.delivered_at).toLocaleString() : '—'}</td>
                <td className="py-2 pr-4 text-red-600">{m.error ?? ''}</td>
              </tr>
            ))}
            {messages.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-ink-400">No messages yet - start the campaign to materialize and send them.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------
function EmailCampaignsTab(): JSX.Element {
  const { hasPermission } = useAuth();
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const campaignsQuery = useEmailCampaigns();
  const campaigns = campaignsQuery.data?.data ?? [];
  const canManage = hasPermission('messaging.manage');

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-500">
          Send templated email campaigns via your organization's SMTP settings.{' '}
          <span className="text-ink-400">Delivered/bounced/replied tracking needs a transactional email provider - not built in this phase; only sent/failed are reported.</span>
        </p>
        {canManage && (
          <Button onClick={() => setShowCreate((v) => !v)}>
            <Plus className="h-4 w-4" /> New email campaign
          </Button>
        )}
      </div>

      {showCreate && <CreateEmailCampaignForm onClose={() => setShowCreate(false)} />}

      {campaignsQuery.isLoading && <p className="mt-8 text-sm text-ink-500">Loading campaigns...</p>}

      {!campaignsQuery.isLoading && campaigns.length === 0 && (
        <Card className="mt-8 flex flex-col items-center justify-center py-16 text-center">
          <Mail className="h-10 w-10 text-ink-300" />
          <p className="mt-3 text-sm font-medium text-ink-700">No email campaigns yet</p>
        </Card>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {campaigns.map((c) => (
          <EmailCampaignCard key={c.id} campaign={c} onToggle={() => setSelectedId(selectedId === c.id ? null : c.id)} />
        ))}
      </div>

      {selectedId && <EmailMessagesPanel campaignId={selectedId} />}
    </div>
  );
}

function EmailCampaignCard({ campaign, onToggle }: { campaign: EmailCampaignWithCounts; onToggle: () => void }): JSX.Element {
  const { hasPermission } = useAuth();
  const start = useEmailCampaignLifecycleAction('start');
  const pause = useEmailCampaignLifecycleAction('pause');
  const resume = useEmailCampaignLifecycleAction('resume');
  const cancel = useEmailCampaignLifecycleAction('cancel');
  const busy = start.isPending || pause.isPending || resume.isPending || cancel.isPending;
  const counts = campaign.counts;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <button className="min-w-0 truncate text-left text-sm font-semibold text-ink-900 hover:underline" onClick={onToggle}>
          {campaign.name}
        </button>
        <Badge tone={STATUS_TONE[campaign.status]}>{campaign.status}</Badge>
      </div>
      <p className="truncate text-xs text-ink-500">{campaign.subject}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-ink-500">
        <span>Queued: {counts.queued}</span>
        <span>Sent: {counts.sent}</span>
        <span>Failed: {counts.failed}</span>
        <span>Total: {counts.total}</span>
        <span className="col-span-2 text-ink-400">Delivered/bounced: not tracked without a transactional provider</span>
      </div>
      {hasPermission('messaging.manage') && (
        <div className="flex flex-wrap gap-2 border-t border-ink-100 pt-3">
          {['draft', 'scheduled', 'paused'].includes(campaign.status) && (
            <Button variant="secondary" disabled={busy} onClick={() => (campaign.status === 'paused' ? resume : start).mutate(campaign.id)}>
              {campaign.status === 'paused' ? 'Resume' : 'Start'}
            </Button>
          )}
          {campaign.status === 'sending' && (
            <Button variant="secondary" disabled={busy} onClick={() => pause.mutate(campaign.id)}>
              Pause
            </Button>
          )}
          {['sending', 'paused', 'scheduled', 'draft'].includes(campaign.status) && (
            <Button variant="ghost" disabled={busy} onClick={() => cancel.mutate(campaign.id)}>
              Cancel
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function CreateEmailCampaignForm({ onClose }: { onClose: () => void }): JSX.Element {
  const createCampaign = useCreateEmailCampaign();
  const leadListsQuery = useLeadLists();
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('Hi {{first_name}}');
  const [html, setHtml] = useState('<p>Hi {{first_name}},</p><p>...</p>');
  const [plainText, setPlainText] = useState('');
  const [leadListId, setLeadListId] = useState('');
  const [throttle, setThrottle] = useState(30);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createCampaign.mutateAsync({
        name,
        subject,
        html_body: html,
        plain_text_body: plainText,
        recipient_lead_list_id: leadListId || undefined,
        throttle_per_minute: throttle,
      });
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to create email campaign.');
    }
  }

  return (
    <Card className="mt-6 max-w-3xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        <h2 className="text-sm font-semibold text-ink-900">New email campaign</h2>
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="email-name">Name</Label>
            <Input id="email-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
          </div>
          <div>
            <Label htmlFor="email-subject">Subject</Label>
            <Input id="email-subject" value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={500} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="email-html">HTML body</Label>
            <textarea
              id="email-html"
              className="h-48 w-full rounded-md border border-ink-300 bg-white px-3 py-2 font-mono text-xs text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              required
            />
            <VariablePalette onInsert={(token) => setHtml((h) => `${h}${token}`)} />
          </div>
          <div>
            <Label>Live preview</Label>
            <div className="h-48 overflow-auto rounded-md border border-ink-200 bg-white p-3 text-sm" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        </div>
        <div>
          <Label htmlFor="email-plain">Plain-text fallback</Label>
          <textarea
            id="email-plain"
            className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
            rows={3}
            value={plainText}
            onChange={(e) => setPlainText(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="email-list">Recipient lead list</Label>
            <select
              id="email-list"
              className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
              value={leadListId}
              onChange={(e) => setLeadListId(e.target.value)}
              required
            >
              <option value="">Select a list</option>
              {(leadListsQuery.data?.data ?? []).map((l: any) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div className="w-40">
            <Label htmlFor="email-throttle">Throttle (per minute)</Label>
            <Input id="email-throttle" type="number" min={1} max={1000} value={throttle} onChange={(e) => setThrottle(Number(e.target.value))} />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={createCampaign.isPending}>
            Create draft
          </Button>
        </div>
      </form>
    </Card>
  );
}

function EmailMessagesPanel({ campaignId }: { campaignId: string }): JSX.Element {
  const { hasPermission } = useAuth();
  const messagesQuery = useEmailMessages(campaignId);
  const messages = messagesQuery.data?.data ?? [];
  const queueExport = useQueueEmailMessagesExport(campaignId);
  return (
    <Card className="mt-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-ink-900">Message status</h3>
          <p className="mt-1 text-xs text-ink-400">Delivered/bounced/replied are not shown here - raw SMTP gives no such signal without a transactional email provider.</p>
        </div>
        {hasPermission('messaging.manage') && (
          <ExportTrigger
            csvType="email_messages_csv"
            xlsxType="email_messages_xlsx"
            pending={queueExport.isPending}
            onExport={(type) => queueExport.mutateAsync({ type })}
          />
        )}
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-ink-100 text-xs uppercase text-ink-400">
              <th className="py-2 pr-4">Recipient</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Sent at</th>
              <th className="py-2 pr-4">Error</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((m) => (
              <tr key={m.id} className="border-b border-ink-50">
                <td className="py-2 pr-4 text-ink-800">{m.recipient_email}</td>
                <td className="py-2 pr-4"><Badge tone={m.status === 'sent' ? 'success' : m.status === 'failed' ? 'danger' : 'neutral'}>{m.status}</Badge></td>
                <td className="py-2 pr-4 text-ink-500">{m.sent_at ? new Date(m.sent_at).toLocaleString() : '—'}</td>
                <td className="py-2 pr-4 text-red-600">{m.error ?? ''}</td>
              </tr>
            ))}
            {messages.length === 0 && (
              <tr>
                <td colSpan={4} className="py-4 text-center text-ink-400">No messages yet - start the campaign to materialize and send them.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
