import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { LiveMonitorSocketProvider } from '../hooks/useLiveMonitor';

export function AppShell(): JSX.Element {
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
            <Outlet />
          </div>
        </main>
      </div>
    </LiveMonitorSocketProvider>
  );
}
