import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';

export function AppShell(): JSX.Element {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-ink-50">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
