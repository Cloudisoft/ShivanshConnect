import { useCallback, useEffect, useState } from 'react';

/**
 * Row selection for paged, filtered lists (CDR, Leads, Voices, DIDs):
 * tick rows, tick every row on the page, or go further and select ALL
 * rows matching the current filters (acted on server-side by filter, not
 * by id). Any change to `resetKey` (the filters) clears the selection, so
 * a selection made under other filters can never ride into a bulk action.
 */
export function useRowSelection(pageIds: string[], resetKey: unknown) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const key = JSON.stringify(resetKey ?? null);

  const clear = useCallback(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, []);
  useEffect(() => clear(), [key, clear]);

  const pageAllSelected = allMatching || (pageIds.length > 0 && pageIds.every((id) => selected.has(id)));

  function toggle(id: string) {
    if (allMatching) {
      // Leaving "all matching": keep this page ticked, minus the row.
      setAllMatching(false);
      setSelected(new Set(pageIds.filter((p) => p !== id)));
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePage() {
    if (pageAllSelected) {
      setAllMatching(false);
      setSelected((prev) => {
        const next = new Set(prev);
        pageIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelected((prev) => new Set([...prev, ...pageIds]));
    }
  }

  return {
    selected,
    allMatching,
    isSelected: (id: string) => allMatching || selected.has(id),
    pageAllSelected,
    somePageSelected: pageIds.some((id) => selected.has(id)),
    toggle,
    togglePage,
    selectAllMatching: () => setAllMatching(true),
    clear,
  };
}

export type RowSelection = ReturnType<typeof useRowSelection>;
