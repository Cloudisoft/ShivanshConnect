import { lazy, type ComponentType } from 'react';

const loaders: Array<() => Promise<unknown>> = [];

/** React.lazy for a route page, also registered so preloadAllPages() can
 * fetch its code ahead of time. */
export function lazyPage<M>(loader: () => Promise<M>, pick: (m: M) => ComponentType<any>) {
  loaders.push(loader);
  return lazy(() => loader().then((m) => ({ default: pick(m) })));
}

let preloaded = false;

/** Downloads every page's code in the background once the app is idle, so
 * the first visit to any page doesn't wait on a chunk download. The browser
 * module cache means lazy() later reuses the same already-loaded module. */
export function preloadAllPages(): void {
  if (preloaded) return;
  preloaded = true;
  const run = () => {
    for (const load of loaders) void load().catch(() => {});
  };
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  if (ric) ric(run);
  else setTimeout(run, 500);
}
