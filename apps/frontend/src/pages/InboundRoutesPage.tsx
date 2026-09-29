import { Alert, Badge, Card } from '../components/ui';
import { useAuth } from '../hooks/useAuth';
import { useInboundRoutes, useUpdateInboundRoute } from '../hooks/useQueues';
import { ApiClientError } from '../lib/apiClient';

/**
 * Inbound routes: which campaign's AI answers each number. A caller we
 * already called is always answered as the campaign that called them;
 * everyone else gets the campaign chosen here (or, by default, the running
 * campaign dialing from that number). If the AI can't answer, the call
 * goes to that campaign's transfer number.
 */
export function InboundRoutesPage(): JSX.Element {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('numbers.manage');
  const routesQuery = useInboundRoutes();
  const updateRoute = useUpdateInboundRoute();
  const routes = routesQuery.data?.routes ?? [];
  const campaigns = routesQuery.data?.campaigns ?? [];

  return (
    <div>
      <h1 className="text-2xl font-semibold text-ink-900">Inbound Routes</h1>
      <p className="mt-1 text-sm text-ink-500">
        Every number answers calls with the AI. Someone returning our call is answered as the campaign that called them,
        greeted by name, and the AI collects their name, phone, email and reason for calling. Other callers get the
        campaign chosen below. If the AI can't answer, the call rings the campaign's transfer number instead.
      </p>

      {updateRoute.isError && (
        <div className="mt-4">
          <Alert variant="error">{updateRoute.error instanceof ApiClientError ? updateRoute.error.message : 'Could not save the route.'}</Alert>
        </div>
      )}

      <Card className="mt-6 p-0">
        {routesQuery.isLoading && !routesQuery.data ? (
          <p className="p-5 text-sm text-ink-500">Loading numbers...</p>
        ) : routes.length === 0 ? (
          <p className="p-5 text-sm text-ink-500">No phone numbers yet. Add one on the DIDs page.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-100 text-xs text-ink-500">
              <tr>
                <th className="px-5 py-3 font-medium">Number</th>
                <th className="px-5 py-3 font-medium">Answering</th>
                <th className="px-5 py-3 font-medium">Answered as</th>
                <th className="px-5 py-3 font-medium">If the AI can't answer</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {routes.map((r) => (
                <tr key={r.phone_number_id}>
                  <td className="px-5 py-3">
                    <p className="text-ink-900">{r.phone_number}</p>
                    {r.friendly_name && <p className="text-xs text-ink-500">{r.friendly_name}</p>}
                  </td>
                  <td className="px-5 py-3">
                    {r.answering ? (
                      <Badge tone="success">AI answering</Badge>
                    ) : (
                      <span title="Starts answering once this number places its first call (it is set up with Vapi then).">
                        <Badge tone="neutral">Not set up yet</Badge>
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <select
                      className="w-full max-w-xs rounded-md border border-ink-300 bg-white px-3 py-2 text-sm"
                      value={r.assigned_campaign_id ?? ''}
                      disabled={!canEdit || updateRoute.isPending}
                      onChange={(e) => updateRoute.mutate({ phoneNumberId: r.phone_number_id, campaignId: e.target.value || null })}
                    >
                      <option value="">
                        Automatic{r.answered_by_campaign && !r.assigned_campaign_id ? ` (${r.answered_by_campaign.name})` : ''}
                      </option>
                      {campaigns.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-5 py-3 text-ink-700">{r.fallback_number ? `Ring ${r.fallback_number}` : 'Hang up (no transfer number set)'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
