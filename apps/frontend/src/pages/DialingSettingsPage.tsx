import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useDialingSettings, useUpdateDialingSettings } from '../hooks/useCampaigns';
import { Alert, Button, Card, Input, Label } from '../components/ui';
import { ApiClientError } from '../lib/apiClient';

export function DialingSettingsPage(): JSX.Element {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');
  const settingsQuery = useDialingSettings();
  const update = useUpdateDialingSettings();
  const [form, setForm] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settingsQuery.data && !form) setForm(settingsQuery.data);
  }, [settingsQuery.data, form]);

  if (settingsQuery.isLoading || !form) {
    return <p className="text-sm text-ink-500">Loading dialing settings...</p>;
  }

  function set<K extends string>(key: K, value: any) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function handleSave() {
    if (!form) return;
    setError(null);
    setSaved(false);
    try {
      await update.mutateAsync({
        default_concurrency: Number(form.default_concurrency),
        max_concurrency: Number(form.max_concurrency),
        calls_per_minute: Number(form.calls_per_minute),
        max_attempts: Number(form.max_attempts),
        retry_delay_minutes: Number(form.retry_delay_minutes),
        lead_cooldown_minutes: Number(form.lead_cooldown_minutes),
        calling_hours_start: form.calling_hours_start,
        calling_hours_end: form.calling_hours_end,
        voicemail_behavior: form.voicemail_behavior,
        amd_enabled: form.amd_enabled,
        failed_call_behavior: form.failed_call_behavior,
        busy_behavior: form.busy_behavior,
        no_answer_behavior: form.no_answer_behavior,
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to save dialing settings.');
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold text-ink-900">Dialing Settings</h1>
      <p className="mt-1 text-sm text-ink-500">Organization-wide defaults for every campaign. Individual campaigns can override these via their Settings tab.</p>

      {error && (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {saved && (
        <div className="mt-4">
          <Alert variant="success">Dialing settings saved.</Alert>
        </div>
      )}

      <Card className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Default concurrency">
          <Input type="number" min={1} value={form.default_concurrency} onChange={(e) => set('default_concurrency', e.target.value)} disabled={!canManage} />
        </Field>
        <Field label="Max concurrency (org-wide cap)">
          <Input type="number" min={1} value={form.max_concurrency} onChange={(e) => set('max_concurrency', e.target.value)} disabled={!canManage} />
        </Field>
        <Field label="Calls per minute">
          <Input type="number" min={1} value={form.calls_per_minute} onChange={(e) => set('calls_per_minute', e.target.value)} disabled={!canManage} />
        </Field>
        <Field label="Max attempts per lead">
          <Input type="number" min={1} value={form.max_attempts} onChange={(e) => set('max_attempts', e.target.value)} disabled={!canManage} />
        </Field>
        <Field label="Retry delay (minutes)">
          <Input type="number" min={1} value={form.retry_delay_minutes} onChange={(e) => set('retry_delay_minutes', e.target.value)} disabled={!canManage} />
        </Field>
        <Field label="Lead cooldown (minutes)">
          <Input type="number" min={0} value={form.lead_cooldown_minutes} onChange={(e) => set('lead_cooldown_minutes', e.target.value)} disabled={!canManage} />
        </Field>
        <Field label="Calling hours start">
          <Input type="time" value={form.calling_hours_start?.slice(0, 5) ?? ''} onChange={(e) => set('calling_hours_start', e.target.value)} disabled={!canManage} />
        </Field>
        <Field label="Calling hours end">
          <Input type="time" value={form.calling_hours_end?.slice(0, 5) ?? ''} onChange={(e) => set('calling_hours_end', e.target.value)} disabled={!canManage} />
        </Field>
        <Field label="Voicemail behavior">
          <select className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm" value={form.voicemail_behavior} onChange={(e) => set('voicemail_behavior', e.target.value)} disabled={!canManage}>
            <option value="leave_message">Leave message</option>
            <option value="hang_up">Hang up</option>
            <option value="retry_later">Retry later</option>
          </select>
        </Field>
        <Field label="Failed-call behavior">
          <select className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm" value={form.failed_call_behavior} onChange={(e) => set('failed_call_behavior', e.target.value)} disabled={!canManage}>
            <option value="retry">Retry</option>
            <option value="skip">Skip</option>
          </select>
        </Field>
        <Field label="Busy behavior">
          <select className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm" value={form.busy_behavior} onChange={(e) => set('busy_behavior', e.target.value)} disabled={!canManage}>
            <option value="retry">Retry</option>
            <option value="skip">Skip</option>
          </select>
        </Field>
        <Field label="No-answer behavior">
          <select className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm" value={form.no_answer_behavior} onChange={(e) => set('no_answer_behavior', e.target.value)} disabled={!canManage}>
            <option value="retry">Retry</option>
            <option value="skip">Skip</option>
          </select>
        </Field>
        <Field label="AMD (answering machine detection)">
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" checked={form.amd_enabled} onChange={(e) => set('amd_enabled', e.target.checked)} disabled={!canManage} />
            Enabled
          </label>
        </Field>
        <Field label="DNC suppression">
          <p className="text-sm text-ink-600">Always active - DNC leads are never dialed, regardless of any other setting.</p>
        </Field>
      </Card>

      {canManage && (
        <div className="mt-6">
          <Button onClick={handleSave} disabled={update.isPending}>
            Save defaults
          </Button>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
