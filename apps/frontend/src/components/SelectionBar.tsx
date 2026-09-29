import { useEffect, useRef, type ReactNode } from 'react';
import { Card } from './ui';
import type { RowSelection } from '../hooks/useRowSelection';

/** Header checkbox: ticks every row on the page (indeterminate when only
 * some are). */
export function SelectPageCheckbox({ selection, label = 'Select all on this page' }: { selection: RowSelection; label?: string }): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !selection.pageAllSelected && selection.somePageSelected;
  }, [selection.pageAllSelected, selection.somePageSelected]);
  return <input ref={ref} type="checkbox" className="h-4 w-4 rounded border-ink-300" checked={selection.pageAllSelected} onChange={selection.togglePage} aria-label={label} />;
}

export function RowCheckbox({ selection, id, label }: { selection: RowSelection; id: string; label: string }): JSX.Element {
  return (
    <input
      type="checkbox"
      className="h-4 w-4 rounded border-ink-300"
      checked={selection.isSelected(id)}
      onChange={() => selection.toggle(id)}
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
    />
  );
}

/** "N selected - Select all M matching - Clear" plus the page's bulk
 * actions. Shown only while something is selected. */
export function SelectionBar({
  selection,
  pageCount,
  total,
  noun,
  children,
}: {
  selection: RowSelection;
  pageCount: number;
  total: number;
  noun: string;
  children: ReactNode;
}): JSX.Element | null {
  const count = selection.allMatching ? total : selection.selected.size;
  if (count === 0) return null;
  return (
    <Card className="mt-4 flex flex-wrap items-center justify-between gap-3 !p-3">
      <div className="flex flex-wrap items-center gap-3 text-sm text-ink-700">
        <span>
          {selection.allMatching ? (
            <>
              All <strong>{total}</strong> matching {noun} selected
            </>
          ) : (
            <>
              <strong>{count}</strong> selected
            </>
          )}
        </span>
        {!selection.allMatching && selection.pageAllSelected && total > pageCount && (
          <button type="button" className="text-xs font-medium text-gold-700 underline" onClick={selection.selectAllMatching}>
            Select all {total} matching {noun}
          </button>
        )}
        <button type="button" className="text-xs text-ink-500 underline" onClick={selection.clear}>
          Clear selection
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </Card>
  );
}
