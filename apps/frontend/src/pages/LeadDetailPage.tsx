import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, PhoneCall, Radio, FileText, Mic } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useLead, useUpdateLead } from '../hooks/useLeads';
import { Alert, Badge, Button, Card, Input, Label } from '../components/ui';
import { ApiClientError } from '../lib/apiClient';
import { LEAD_STATUSES, type LeadStatus } from '@shivanshconnect/shared';

export function LeadDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const leadQuery = useLead(id);
  const updateLead = useUpdateLead();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lead = leadQuery.data;

  if (leadQuery.isLoading) {
    return <p className="text-sm text-ink-500">Loading lead...</p>;
  }
  if (!lead) {
    return (
      <div>
        <button className="flex items-center gap-1 text-sm text-ink-500 hover:text-ink-800" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <Card className="mt-6">
          <p className="text-sm text-ink-600">This lead was not found.</p>
        </Card>
      </div>
    );
  }

  async function handleSubmit(form: Record<string, unknown>) {
    setError(null);
    try {
      await updateLead.mutateAsync({ id: lead!.id, ...form });
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not save this lead.');
    }
  }

  return (
    <div>
      <button className="flex items-center gap-1 text-sm text-ink-500 hover:text-ink-800" onClick={() => navigate(-1)}>
        <ArrowLeft className="h-4 w-4" /> Back to leads
      </button>

      <div className="mt-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">
            {lead.first_name || lead.last_name ? `${lead.first_name} ${lead.last_name}`.trim() : lead.phone_normalized}
          </h1>
          <p className="mt-1 font-mono text-sm text-ink-500">{lead.phone_normalized}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={lead.status === 'DNC' ? 'danger' : lead.status === 'COMPLETED' ? 'success' : 'neutral'}>
            {lead.status}
          </Badge>
          {lead.is_dnc && <Badge tone="danger">DNC</Badge>}
          {hasPermission('leads.edit') && !editing && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      )}

      {editing ? (
        <EditLeadForm lead={lead} onCancel={() => setEditing(false)} onSubmit={handleSubmit} pending={updateLead.isPending} />
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card>
            <h2 className="text-sm font-semibold text-ink-900">Contact</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <Row label="Company" value={lead.company} />
              <Row label="Email" value={lead.email} />
              <Row label="Address" value={[lead.address, lead.city, lead.state, lead.zip].filter(Boolean).join(', ')} />
              <Row label="Country" value={lead.country} />
              <Row label="List" value={lead.lists.map((l) => l.name).join(', ') || null} />
              <Row label="Phone (as entered)" value={lead.phone_original} />
              <Row label="Added" value={new Date(lead.created_at).toLocaleString()} />
            </dl>
          </Card>
          <Card>
            <h2 className="text-sm font-semibold text-ink-900">Dialing status</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <Row label="Attempts" value={String(lead.attempts)} />
              <Row label="Last called" value={lead.last_called_at ? new Date(lead.last_called_at).toLocaleString() : null} />
              <Row label="Last disposition" value={lead.last_disposition} />
              <Row label="Next callback" value={lead.next_callback_at ? new Date(lead.next_callback_at).toLocaleString() : null} />
              <Row label="DNC reason" value={lead.dnc_reason} />
            </dl>
          </Card>
          {Object.keys(lead.custom_fields ?? {}).length > 0 && (
            <Card className="lg:col-span-2">
              <h2 className="text-sm font-semibold text-ink-900">Custom fields</h2>
              <dl className="mt-3 grid gap-2 sm:grid-cols-2">
                {Object.entries(lead.custom_fields).map(([key, value]) => (
                  <Row key={key} label={key} value={String(value)} />
                ))}
              </dl>
            </Card>
          )}
        </div>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <EmptySection icon={PhoneCall} title="Call History" note="Arrives with the dialer phase (call records / CDR)." />
        <EmptySection icon={Radio} title="Campaign History" note="Arrives once campaigns exist (Phase 3)." />
        <EmptySection icon={Mic} title="Recordings" note="Arrives with voice/telephony integration." />
        <EmptySection icon={FileText} title="Transcripts" note="Arrives with AI agent + call transcription." />
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }): JSX.Element {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-ink-500">{label}</dt>
      <dd className="text-right text-ink-800">{value || '—'}</dd>
    </div>
  );
}

function EmptySection({
  icon: Icon,
  title,
  note,
}: {
  icon: typeof PhoneCall;
  title: string;
  note: string;
}): JSX.Element {
  return (
    <Card className="flex flex-col items-center justify-center py-8 text-center">
      <Icon className="h-6 w-6 text-ink-300" />
      <p className="mt-2 text-sm font-medium text-ink-700">{title}</p>
      <p className="mt-1 text-xs text-ink-500">{note}</p>
    </Card>
  );
}

function EditLeadForm({
  lead,
  onCancel,
  onSubmit,
  pending,
}: {
  lead: NonNullable<ReturnType<typeof useLead>['data']>;
  onCancel: () => void;
  onSubmit: (form: Record<string, unknown>) => void;
  pending: boolean;
}): JSX.Element {
  const [form, setForm] = useState({
    first_name: lead.first_name,
    last_name: lead.last_name,
    company: lead.company ?? '',
    phone: lead.phone_normalized,
    email: lead.email ?? '',
    status: lead.status as LeadStatus,
    last_disposition: lead.last_disposition ?? '',
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSubmit({
      first_name: form.first_name,
      last_name: form.last_name,
      company: form.company || null,
      phone: form.phone,
      email: form.email || null,
      status: form.status,
      last_disposition: form.last_disposition || null,
    });
  }

  return (
    <Card className="mt-6">
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
        <div>
          <Label htmlFor="edit_first_name">First name</Label>
          <Input id="edit_first_name" value={form.first_name} onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))} />
        </div>
        <div>
          <Label htmlFor="edit_last_name">Last name</Label>
          <Input id="edit_last_name" value={form.last_name} onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))} />
        </div>
        <div>
          <Label htmlFor="edit_phone">Phone</Label>
          <Input id="edit_phone" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} required />
        </div>
        <div>
          <Label htmlFor="edit_email">Email</Label>
          <Input id="edit_email" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
        </div>
        <div>
          <Label htmlFor="edit_company">Company</Label>
          <Input id="edit_company" value={form.company} onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))} />
        </div>
        <div>
          <Label htmlFor="edit_status">Status</Label>
          <select
            id="edit_status"
            className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm"
            value={form.status}
            onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as LeadStatus }))}
          >
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="edit_disposition">Last disposition</Label>
          <Input
            id="edit_disposition"
            value={form.last_disposition}
            onChange={(e) => setForm((f) => ({ ...f, last_disposition: e.target.value }))}
          />
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving...' : 'Save changes'}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
