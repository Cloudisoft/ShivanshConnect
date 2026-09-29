import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { VOICE_PROVIDER_LABELS, type Voice } from '@shivanshconnect/shared';
import { useVoice, useVoices } from '../hooks/useVoices';

/**
 * Searchable voice picker (campaign and agent settings). A plain <select>
 * could only hold the first 100 of an organization's voices; this
 * searches every active voice on the server as you type, and always shows
 * the currently chosen voice even when it isn't in the results.
 */
export function VoiceSelect({
  id,
  value,
  onChange,
  emptyLabel,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (voiceId: string) => void;
  emptyLabel: string;
  disabled?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const voicesQuery = useVoices({ status: 'active', search: search || undefined });
  const results = voicesQuery.data?.data ?? [];
  const total = voicesQuery.data?.pagination?.total ?? results.length;
  const selectedQuery = useVoice(value || undefined);
  const selected = value ? results.find((v) => v.id === value) ?? selectedQuery.data : undefined;

  function pick(voiceId: string) {
    onChange(voiceId);
    setOpen(false);
    setText('');
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-ink-300 bg-white px-3 py-2 text-left text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500 disabled:cursor-not-allowed disabled:bg-ink-50"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">{value ? (selected ? voiceLabel(selected) : 'Loading...') : emptyLabel}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-ink-400" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-md border border-ink-200 bg-white shadow-lg" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
          <div className="relative border-b border-ink-100 p-2">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
            <input
              ref={inputRef}
              type="search"
              className="w-full rounded-md border border-ink-300 py-1.5 pl-8 pr-2 text-sm focus:border-ink-500 focus:outline-none"
              placeholder="Search voices by name..."
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <ul role="listbox" className="max-h-72 overflow-y-auto py-1 text-sm">
            <li>
              <button type="button" className="w-full px-3 py-2 text-left text-ink-600 hover:bg-ink-50" onClick={() => pick('')}>
                {emptyLabel}
              </button>
            </li>
            {results.map((v) => (
              <li key={v.id} role="option" aria-selected={v.id === value}>
                <button
                  type="button"
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-ink-50 ${v.id === value ? 'bg-gold-50 font-medium' : ''}`}
                  onClick={() => pick(v.id)}
                >
                  <span className="truncate text-ink-900">{v.name}</span>
                  <span className="shrink-0 text-xs text-ink-500">{voiceMeta(v)}</span>
                </button>
              </li>
            ))}
            {!voicesQuery.isLoading && results.length === 0 && <li className="px-3 py-2 text-ink-500">No voices match "{search}".</li>}
            {voicesQuery.isLoading && <li className="px-3 py-2 text-ink-500">Loading voices...</li>}
          </ul>
          {total > results.length && (
            <p className="border-t border-ink-100 px-3 py-1.5 text-xs text-ink-500">
              Showing {results.length} of {total} - type to search the rest.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function voiceMeta(v: Voice): string {
  const parts = [VOICE_PROVIDER_LABELS[v.provider_key] ?? v.provider_key];
  if (v.is_cloned) parts.push('Cloned');
  if (v.gender && v.gender !== 'unknown') parts.push(v.gender);
  if (v.requires_external_hosting) parts.push('self-hosted');
  return parts.join(' · ');
}

function voiceLabel(v: Voice): string {
  return `${v.name} (${voiceMeta(v)})${v.status !== 'active' ? ' - hidden' : ''}`;
}
