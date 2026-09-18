import clsx from 'clsx';
import type { AnalyticsPeriod } from '@shivanshconnect/shared';
import type { PeriodFilterValue } from '../../hooks/useAnalytics';

const TABS: Array<{ value: AnalyticsPeriod; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
  { value: 'custom', label: 'Custom' },
];

/** Time-filter tabs (spec section 6) shared by the Dashboard and
 * Analytics pages - Today/Yesterday/7 Days/30 Days/Custom date range. */
export function PeriodFilter({ value, onChange }: { value: PeriodFilterValue; onChange: (next: PeriodFilterValue) => void }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-md border border-ink-200 bg-white p-1">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => onChange(tab.value === 'custom' ? { period: 'custom', date_from: value.date_from, date_to: value.date_to } : { period: tab.value })}
            className={clsx(
              'rounded px-3 py-1.5 text-sm font-medium transition-colors',
              value.period === tab.value ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-100',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {value.period === 'custom' && (
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={value.date_from ?? ''}
            onChange={(e) => onChange({ period: 'custom', date_from: e.target.value, date_to: value.date_to })}
            className="rounded-md border border-ink-300 px-2 py-1.5 text-sm text-ink-800"
          />
          <span className="text-sm text-ink-400">to</span>
          <input
            type="date"
            value={value.date_to ?? ''}
            onChange={(e) => onChange({ period: 'custom', date_from: value.date_from, date_to: e.target.value })}
            className="rounded-md border border-ink-300 px-2 py-1.5 text-sm text-ink-800"
          />
        </div>
      )}
    </div>
  );
}
