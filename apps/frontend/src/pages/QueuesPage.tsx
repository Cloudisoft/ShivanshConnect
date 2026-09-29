import { Link } from 'react-router-dom';
import { CalendarClock, PhoneIncoming, PhoneOutgoing } from 'lucide-react';
import { Badge, Card } from '../components/ui';
import { useQueueSummary } from '../hooks/useQueues';

function formatWhen(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

function Stat({ label, value }: { label: string; value: number | string }): JSX.Element {
  return (
    <div>
      <p className="text-xs text-ink-500">{label}</p>
      <p className="text-2xl font-semibold text-ink-900">{value}</p>
    </div>
  );
}

/**
 * Call queues: who is waiting to be called (each campaign's outbound
 * queue), callbacks coming due, and live inbound calls. Callers ringing in
 * are answered first - each live inbound call holds back one outbound dial.
 */
export function QueuesPage(): JSX.Element {
  const summaryQuery = useQueueSummary();
  const summary = summaryQuery.data;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-ink-900">Queues</h1>
      <p className="mt-1 text-sm text-ink-500">
        What's waiting to be called and what's live right now. People calling in are answered first; outbound
        dialing uses whatever capacity is left. Updates every 10 seconds.
      </p>

      {summaryQuery.isLoading && !summary ? (
        <p className="mt-6 text-sm text-ink-500">Loading queues...</p>
      ) : summaryQuery.isError && !summary ? (
        <p className="mt-6 text-sm text-red-700">Could not load the queues. Please refresh.</p>
      ) : summary ? (
        <div className="mt-6 space-y-6">
          <Card className="p-5">
            <div className="flex items-center gap-2">
              <PhoneIncoming className="h-5 w-5 text-ink-500" />
              <h2 className="text-lg font-semibold text-ink-900">Inbound</h2>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat label="On a call now" value={summary.inbound.on_call} />
              <Stat label="Calls received today" value={summary.inbound.today} />
              <Stat label="Numbers answering" value={`${summary.inbound.answering_numbers} of ${summary.inbound.total_numbers}`} />
            </div>
            <p className="mt-3 text-xs text-ink-500">
              Which campaign answers each number is set on <Link className="underline" to="/inbound-routes">Inbound Routes</Link>.
            </p>
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5 text-ink-500" />
              <h2 className="text-lg font-semibold text-ink-900">Callbacks</h2>
              {summary.callbacks.due_now > 0 && <Badge tone="warning">{summary.callbacks.due_now} due now</Badge>}
            </div>
            {summary.callbacks.upcoming.length === 0 ? (
              <p className="mt-3 text-sm text-ink-500">No callbacks scheduled.</p>
            ) : (
              <table className="mt-3 w-full text-left text-sm">
                <thead className="text-xs text-ink-500">
                  <tr>
                    <th className="py-2 pr-3 font-medium">When</th>
                    <th className="py-2 pr-3 font-medium">Who</th>
                    <th className="py-2 pr-3 font-medium">Campaign</th>
                    <th className="py-2 pr-3 font-medium">Reason</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {summary.callbacks.upcoming.map((cb) => (
                    <tr key={cb.id}>
                      <td className="py-2 pr-3 text-ink-900">{formatWhen(cb.scheduled_at, cb.timezone)}</td>
                      <td className="py-2 pr-3">
                        <Link className="text-ink-900 hover:underline" to={`/leads/${cb.lead_id}`}>
                          {cb.lead_name || cb.phone_e164}
                        </Link>
                        {cb.lead_name && <span className="ml-2 text-xs text-ink-500">{cb.phone_e164}</span>}
                      </td>
                      <td className="py-2 pr-3 text-ink-700">{cb.campaign_name ?? '-'}</td>
                      <td className="py-2 pr-3 text-ink-700">{cb.reason ?? '-'}</td>
                      <td className="py-2">
                        <Badge tone={cb.status === 'calling' ? 'warning' : 'neutral'}>{cb.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-3 text-xs text-ink-500">
              The AI calls each person back at the agreed time (within the campaign's calling hours). Manage them on{' '}
              <Link className="underline" to="/callbacks">Callbacks</Link>.
            </p>
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2">
              <PhoneOutgoing className="h-5 w-5 text-ink-500" />
              <h2 className="text-lg font-semibold text-ink-900">Outbound</h2>
            </div>
            {summary.outbound.length === 0 ? (
              <p className="mt-3 text-sm text-ink-500">No active campaigns.</p>
            ) : (
              <table className="mt-3 w-full text-left text-sm">
                <thead className="text-xs text-ink-500">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Campaign</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">Waiting to be called</th>
                    <th className="py-2 pr-3 font-medium">Scheduled for later</th>
                    <th className="py-2 font-medium">On a call now</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {summary.outbound.map((q) => (
                    <tr key={q.campaign_id}>
                      <td className="py-2 pr-3">
                        <Link className="text-ink-900 hover:underline" to={`/campaigns/${q.campaign_id}`}>
                          {q.name}
                        </Link>
                      </td>
                      <td className="py-2 pr-3">
                        <Badge tone={q.status === 'running' ? 'success' : 'neutral'}>{q.status}</Badge>
                      </td>
                      <td className="py-2 pr-3 text-ink-900">{q.waiting_now}</td>
                      <td className="py-2 pr-3 text-ink-700">{q.scheduled_later}</td>
                      <td className="py-2 text-ink-900">
                        {q.on_call}
                        {q.concurrency_limit ? <span className="text-xs text-ink-500"> / {q.concurrency_limit} max</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      ) : null}
    </div>
  );
}
