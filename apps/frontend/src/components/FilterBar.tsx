import { useEffect, useState, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';

/**
 * Shared filter controls for list pages (CDR, Leads, Voices, DIDs) so
 * every page's filters look and behave the same: labelled selects, a
 * debounced search box and a "Clear filters" link shown while any filter
 * is active.
 */
export function FilterBar({ children, active, onClear }: { children: ReactNode; active: boolean; onClear: () => void }): JSX.Element {
  return (
    <div className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-ink-200 bg-white p-3">
      {children}
      {active && (
        <button type="button" className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-ink-500 hover:text-ink-900" onClick={onClear}>
          <X className="h-3.5 w-3.5" /> Clear filters
        </button>
      )}
    </div>
  );
}

const FIELD = 'rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500';

export function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  allLabel: string;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-ink-600">
      {label}
      <select className={FIELD} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Text search that only reports a change after typing pauses (350 ms),
 * so a list isn't refetched on every keystroke. */
export function FilterSearch({
  label,
  value,
  onChange,
  placeholder,
  className = 'min-w-[200px] flex-1',
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  placeholder?: string;
  className?: string;
}): JSX.Element {
  const [text, setText] = useState(value ?? '');
  // Follow outside changes (e.g. "Clear filters") without undoing what
  // is being typed ("john " must not lose its trailing space).
  useEffect(() => setText((t) => (t.trim() === (value ?? '') ? t : value ?? '')), [value]);
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === (value ?? '')) return undefined;
    const t = setTimeout(() => onChange(trimmed || undefined), 350);
    return () => clearTimeout(t);
  }, [text, value, onChange]);
  return (
    <label className={`flex flex-col gap-1 text-xs font-medium text-ink-600 ${className}`}>
      {label}
      <span className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
        <input type="search" className={`${FIELD} w-full pl-8`} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} />
      </span>
    </label>
  );
}

export function FilterDate({ label, value, onChange }: { label: string; value: string | undefined; onChange: (value: string | undefined) => void }): JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-ink-600">
      {label}
      <input type="date" className={FIELD} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)} />
    </label>
  );
}

/** A yyyy-mm-dd date picked in the browser -> ISO timestamp at the start
 * (or end) of that day in the viewer's own time zone. */
export function dayToIso(day: string | undefined, endOfDay = false): string | undefined {
  if (!day) return undefined;
  const d = new Date(`${day}T${endOfDay ? '23:59:59.999' : '00:00:00'}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function hasActiveFilters(filters: object): boolean {
  return Object.values(filters).some((v) => v !== undefined && v !== '' && v !== false);
}
