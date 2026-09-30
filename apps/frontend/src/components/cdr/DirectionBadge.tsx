import { PhoneIncoming, PhoneOutgoing } from 'lucide-react';
import clsx from 'clsx';

/** Which way a call went - someone calling in, or the AI calling out. */
export function DirectionBadge({ direction }: { direction: 'inbound' | 'outbound' }): JSX.Element {
  const incoming = direction === 'inbound';
  const Icon = incoming ? PhoneIncoming : PhoneOutgoing;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        incoming ? 'bg-sky-100 text-sky-700' : 'bg-ink-100 text-ink-700',
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {incoming ? 'Incoming' : 'Outgoing'}
    </span>
  );
}

/** The customer's number: who called us on an incoming call, who we called on an outgoing one. */
export function customerNumber(row: { direction: 'inbound' | 'outbound'; caller_number: string; destination_number: string }): string {
  return row.direction === 'inbound' ? row.caller_number : row.destination_number;
}
