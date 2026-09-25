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
}

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
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary:${this.props.label}]`, error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <Card className="mt-4 border-red-200 bg-red-50">
          <p className="text-sm font-medium text-red-700">
            {this.props.label} hit an unexpected error and couldn&apos;t render.
          </p>
          <p className="mt-1 text-xs text-red-600">{this.state.error.message}</p>
          <Button variant="secondary" className="mt-3" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </Card>
      );
    }
    return this.props.children;
  }
}
