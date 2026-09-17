import { useState, useRef, useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, Settings, User as UserIcon } from 'lucide-react';
import clsx from 'clsx';
import { NAV_ITEMS } from '../lib/navigation';
import { useAuth } from '../hooks/useAuth';

export function Sidebar(): JSX.Element {
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const initial = (me?.user.full_name || me?.user.email || '?').trim().charAt(0).toUpperCase();
  const roleLabel = me?.roles[0]?.name.replace(/_/g, ' ') ?? '';

  return (
    <aside className="flex h-full w-64 flex-shrink-0 flex-col border-r border-ink-200 bg-white">
      <div className="flex items-center gap-2 border-b border-ink-200 px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-ink-900">
          <span className="text-sm font-bold text-gold-500">SC</span>
        </div>
        <span className="text-base font-semibold tracking-tight text-ink-900">ShivanshConnect</span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => (
            <li key={item.id}>
              <NavLink
                to={item.path}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-gold-500 font-semibold text-ink-900'
                      : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
                  )
                }
              >
                <item.icon className="h-4 w-4 flex-shrink-0" strokeWidth={2} />
                <span className="truncate">{item.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="relative border-t border-ink-200 p-3" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-ink-100"
        >
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-ink-800 text-sm font-semibold text-white">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink-900">
              {me?.user.full_name || me?.user.email || 'Loading...'}
            </p>
            <p className="truncate text-xs capitalize text-ink-500">{roleLabel.toLowerCase()}</p>
          </div>
          <ChevronDown className="h-4 w-4 flex-shrink-0 text-ink-400" />
        </button>

        {menuOpen && (
          <div className="absolute bottom-full left-3 right-3 mb-2 overflow-hidden rounded-md border border-ink-200 bg-white shadow-lg">
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-100"
              onClick={() => {
                setMenuOpen(false);
                navigate('/settings/profile');
              }}
            >
              <UserIcon className="h-4 w-4" /> Profile
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-100"
              onClick={() => {
                setMenuOpen(false);
                navigate('/settings');
              }}
            >
              <Settings className="h-4 w-4" /> Settings
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 border-t border-ink-200 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
              onClick={async () => {
                setMenuOpen(false);
                await signOut();
                navigate('/login');
              }}
            >
              <LogOut className="h-4 w-4" /> Logout
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
