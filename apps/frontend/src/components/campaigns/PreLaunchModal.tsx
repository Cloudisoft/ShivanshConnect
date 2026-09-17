import { CheckCircle2, XCircle } from 'lucide-react';
import type { PreflightResult } from '@shivanshconnect/shared';
import { Button } from '../ui';
import type { CampaignDetail } from '../../hooks/useCampaigns';

/**
 * Spec section 67's pre-launch confirmation modal: shows the campaign's
 * key facts and every preflight error, and only enables Start when
 * preflight is actually ready - never a client-side-only confirmation.
 */
export function PreLaunchModal({
  campaign,
  preflight,
  isStarting,
  onConfirm,
  onClose,
}: {
  campaign: CampaignDetail;
  preflight: PreflightResult | undefined;
  isStarting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}): JSX.Element {
  const ready = preflight?.ready ?? false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-ink-900">Ready to launch "{campaign.name}"?</h2>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-ink-500">Leads</dt>
          <dd className="text-ink-900">{campaign.counts.total} total, {campaign.counts.pending + campaign.counts.retry_pending} eligible</dd>
          <dt className="text-ink-500">Concurrency</dt>
          <dd className="text-ink-900">{campaign.concurrency_limit} simultaneous calls</dd>
          <dt className="text-ink-500">Calling hours</dt>
          <dd className="text-ink-900">
            {campaign.calling_window_start}-{campaign.calling_window_end} ({campaign.timezone})
          </dd>
          <dt className="text-ink-500">Calling days</dt>
          <dd className="text-ink-900">{campaign.calling_days.length} day(s)/week</dd>
          <dt className="text-ink-500">Transfer number</dt>
          <dd className="text-ink-900">{campaign.transfer_number_e164 ?? 'Not set'}</dd>
        </dl>

        <div className="mt-4 space-y-2">
          {!preflight && <p className="text-sm text-ink-500">Checking readiness...</p>}
          {preflight && ready && (
            <div className="flex items-center gap-2 text-sm text-green-700">
              <CheckCircle2 className="h-4 w-4" /> This campaign is ready to start.
            </div>
          )}
          {preflight &&
            !ready &&
            preflight.errors.map((e) => (
              <div key={e.code} className="flex items-start gap-2 text-sm text-red-700">
                <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{e.message}</span>
              </div>
            ))}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready || isStarting} onClick={onConfirm}>
            {isStarting ? 'Starting...' : 'Start campaign'}
          </Button>
        </div>
      </div>
    </div>
  );
}
