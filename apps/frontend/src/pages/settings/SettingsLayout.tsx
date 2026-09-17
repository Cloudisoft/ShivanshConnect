import { NavLink, Outlet } from 'react-router-dom';
import clsx from 'clsx';
import { useAuth } from '../../hooks/useAuth';

const TABS = [
  { path: '/settings/organization', label: 'Organization', permission: 'settings.manage' },
  { path: '/settings/profile', label: 'Profile', permission: null },
  { path: '/settings/security', label: 'Security', permission: null },
  { path: '/settings/users', label: 'Users', permission: 'users.manage' },
  { path: '/settings/roles', label: 'Roles', permission: 'roles.manage' },
  { path: '/settings/compliance', label: 'Compliance', permission: 'leads.view' },
  { path: '/settings/integrations', label: 'Integrations', permission: null },
];

export function SettingsLayout(): JSX.Element {
  const { hasPermission } = useAuth();
  const visibleTabs = TABS.filter((t) => !t.permission || hasPermission(t.permission));

  return (
    <div>
      <h1 className="text-2xl font-semibold text-ink-900">Settings</h1>
      <div className="mt-6 flex gap-6 border-b border-ink-200">
        {visibleTabs.map((tab) => (
          <NavLink
            key={tab.path}
            to={tab.path}
            className={({ isActive }) =>
              clsx(
                'border-b-2 pb-3 text-sm font-medium transition-colors',
                isActive ? 'border-gold-500 text-ink-900' : 'border-transparent text-ink-500 hover:text-ink-800',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </div>
      <div className="mt-6">
        <Outlet />
      </div>
    </div>
  );
}
