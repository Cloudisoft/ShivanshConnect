import { useState } from 'react';
import type { WebhookEvent } from '@shivanshconnect/shared';
import { useAuth } from '../../hooks/useAuth';
import { useReplayWebhookEvent, useWebhookEvents, type WebhookEventFilters } from '../../hooks/useOrchestration';
import { Alert, Badge, Button, Card } from '../../components/ui';
import { ApiClientError } from '../../lib/apiClient';

function statusTone(status: WebhookEvent['processing_status']): 'success' | 'danger' | 'neutral' {
  if (status === 'processed') return 'success';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

function ReplayButton({ event }: { event: WebhookEvent }): JSX.Element {
  const { hasPermission } = useAuth();
  const replay = useReplayWebhookEvent();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!hasPermission('webhooks.manage')) return <span className="text-xs text-ink-400">&ndash;</span>;

  return (
    <div>
      <Button
        variant="secondary"
        className="px-2 py-1 text-xs"
        disabled={replay.isPending}
        onClick={async () => {
          setError(null);
          setDone(false);
          try {
            await replay.mutateAsync(event.id);
            setDone(true);
          } catch (err) {
            setError(err instanceof ApiClientError ? err.message : 'Replay failed.');
          }
        }}
      >
        {replay.isPending ? 'Replaying...' : 'Replay'}
      </Button>
      {done && <p className="mt-1 text-xs text-green-700">Replayed.</p>}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

export function WebhookEventsSettingsPage(): JSX.Element {
  const [filters, setFilters] = useState<WebhookEventFilters>({});
  const eventsQuery = useWebhookEvents(filters);
  const events = eventsQuery.data?.data ?? [];

  return (
    <div>
      <h2 className="text-base font-semibold text-ink-900">Webhook events</h2>
      <p className="mt-1 text-sm text-ink-500">
        Raw inbound delivery log from Vapi, Pipecat, Twilio and Telnyx - every delivery is deduplicated by its own
        provider event id, so a genuine retry never processes twice. Failed deliveries can be replayed here.
      </p>

      <div className="mt-4 flex flex-wrap gap-3">
        <select
          className="rounded-md border border-ink-300 bg-white px-2 py-1 text-xs"
          value={filters.provider ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, provider: e.target.value || undefined }))}
        >
          <option value="">All providers</option>
          <option value="vapi">Vapi</option>
          <option value="pipecat">Pipecat</option>
          <option value="twilio">Twilio</option>
          <option value="telnyx">Telnyx</option>
        </select>
        <select
          className="rounded-md border border-ink-300 bg-white px-2 py-1 text-xs"
          value={filters.processing_status ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, processing_status: e.target.value || undefined }))}
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="processing">Processing</option>
          <option value="processed">Processed</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      <Card className="mt-4 overflow-x-auto p-0">
        {eventsQuery.isLoading && <p className="p-4 text-sm text-ink-500">Loading...</p>}
        {!eventsQuery.isLoading && events.length === 0 && <p className="p-4 text-sm text-ink-500">No webhook events yet.</p>}
        {events.length > 0 && (
          <table className="min-w-full divide-y divide-ink-100 text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="px-4 py-2">Received</th>
                <th className="px-4 py-2">Provider</th>
                <th className="px-4 py-2">Event type</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Error</th>
                <th className="px-4 py-2">Retries</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="px-4 py-2 text-xs text-ink-600">{new Date(event.received_at).toLocaleString()}</td>
                  <td className="px-4 py-2">
                    <Badge tone="neutral">{event.provider}</Badge>
                  </td>
                  <td className="px-4 py-2 text-xs text-ink-700">{event.event_type}</td>
                  <td className="px-4 py-2">
                    <Badge tone={statusTone(event.processing_status)}>{event.processing_status}</Badge>
                  </td>
                  <td className="max-w-xs truncate px-4 py-2 text-xs text-red-600">{event.error ?? ''}</td>
                  <td className="px-4 py-2 text-xs text-ink-600">{event.retry_count}</td>
                  <td className="px-4 py-2">
                    {event.processing_status === 'failed' && <ReplayButton event={event} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {eventsQuery.isError && (
        <div className="mt-4">
          <Alert>Could not load webhook events.</Alert>
        </div>
      )}
    </div>
  );
}
