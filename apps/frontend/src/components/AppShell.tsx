import { Suspense, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { LiveMonitorSocketProvider } from '../hooks/useLiveMonitor';
import { preloadAllPages } from '../lib/lazyPage';

export function AppShell(): JSX.Element {
  useEffect(() => {
    preloadAllPages();
  }, []);

  return (
    // One shared live-call WebSocket for the whole authenticated app - see
    // useLiveMonitor.tsx's header comment. Every route under here can push-
    // invalidate CDR/Campaigns instantly on a call event, not only while
    // Live Monitor or Dashboard specifically happens to be mounted.
    <LiveMonitorSocketProvider>
      <div className="flex h-screen w-full overflow-hidden bg-ink-50">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-8 py-8">
            {/* Page-level boundary: a page whose code is still downloading
                only shows a small spinner in the content area - the
                sidebar never disappears behind App.tsx's full-screen
                fallback on navigation. */}
            <Suspense
              fallback={
                <div className="flex justify-center py-16">
                  <Loader2 className="h-5 w-5 animate-spin text-ink-400" />
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
    </LiveMonitorSocketProvider>
  );
}
