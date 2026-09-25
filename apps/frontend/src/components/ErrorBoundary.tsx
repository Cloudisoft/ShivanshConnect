import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Card } from './ui';

interface Props {
  children: ReactNode;
  /** A short label for what this boundary guards, shown in the fallback
   * so a report like "Leads table crashed" is actionable instead of a
   * generic "something broke somewhere". */
  label: string;
}

interface State {
  error: Error | null;
  isStaleChunk: boolean;
}

/** Vite's real error text (varies slightly by browser) when a lazy
 * `import()` requests a hashed chunk file that no longer exists on the
 * server - which happens to EVERY tab left open across a deploy, since
 * each deploy's build replaces every hashed asset in dist/assets/ wholesale.
 * A user on an old tab who navigates to a route not yet loaded in that tab
 * gets exactly this, and it's fatal here: it unmounts to this top-level
 * boundary since a failed dynamic import isn't something "Try again"
 * (a plain state reset) can recover from - the browser's already-failed
 * fetch for that exact URL isn't retried by re-rendering. */
function isStaleChunkError(error: Error): boolean {
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(
    error.message,
  );
}

/** Guards the one auto-reload below from looping forever if reloading
 * genuinely doesn't fix it (e.g. the new deploy itself is broken) - cleared
 * on every fresh page load (see main.tsx) so a LATER deploy can still
 * trigger one fresh auto-reload of its own. */
const RELOAD_GUARD_KEY = 'sc_chunk_reload_attempted';

/**
 * React unmounts a crashed subtree with no visible trace once it hits an
 * error boundary (or the whole app, if none exists) - this codebase had
 * none anywhere, so a render-time exception in any single component (a
 * malformed field in one row of real data, a third-party library quirk)
 * would silently blank that section with nothing in the UI to explain
 * why, indistinguishable from "there's no data". Wrapping the
 * data-heavy, least-trusted-input areas (starting with the Leads table)
 * turns that silent blank into a real, reportable error message.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, isStaleChunk: false };

  static getDerivedStateFromError(error: Error): State {
    return { error, isStaleChunk: isStaleChunkError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary:${this.props.label}]`, error, info.componentStack);

    if (isStaleChunkError(error) && !sessionStorage.getItem(RELOAD_GUARD_KEY)) {
      // One automatic reload, silently - this is a deploy artifact, not a
      // real bug the user needs to see or act on. window.location.reload()
      // fetches a fresh index.html referencing the CURRENTLY deployed
      // chunk hashes, which is the only thing that actually fixes this
      // (re-rendering the same lazy() component just re-requests the same
      // dead URL and fails again).
      sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
      window.location.reload();
    }
  }

  render(): ReactNode {
    if (this.state.error) {
      if (this.state.isStaleChunk) {
        // Reached only if the guarded auto-reload above already fired once
        // this session and it happened again - genuinely stuck, not just a
        // one-off race with an in-flight deploy.
        return (
          <Card className="mt-4 border-gold-200 bg-gold-50">
            <p className="text-sm font-medium text-ink-900">A new version of ShivanshConnect was just released.</p>
            <p className="mt-1 text-xs text-ink-600">Reload the page to pick it up.</p>
            <Button variant="secondary" className="mt-3" onClick={() => window.location.reload()}>
              Reload page
            </Button>
          </Card>
        );
      }
      return (
        <Card className="mt-4 border-red-200 bg-red-50">
          <p className="text-sm font-medium text-red-700">
            {this.props.label} hit an unexpected error and couldn&apos;t render.
          </p>
          <p className="mt-1 text-xs text-red-600">{this.state.error.message}</p>
          <Button variant="secondary" className="mt-3" onClick={() => this.setState({ error: null, isStaleChunk: false })}>
            Try again
          </Button>
        </Card>
      );
    }
    return this.props.children;
  }
}
