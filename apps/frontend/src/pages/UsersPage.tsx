import { useState, type FormEvent } from 'react';
import { Mail, Plus, X } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import {
  useInviteUser,
  useInvitations,
  useRevokeInvitation,
  useRoles,
  useUpdateUser,
  useUsersList,
} from '../hooks/useUsers';
import { Alert, Badge, Button, Card, Input, Label } from '../components/ui';
import { ApiClientError } from '../lib/apiClient';

export function UsersPage(): JSX.Element {
  const { hasPermission, me } = useAuth();
  const canManage = hasPermission('users.manage');
  const [page, setPage] = useState(1);
  const [showInvite, setShowInvite] = useState(false);

  const usersQuery = useUsersList(page);
  const invitationsQuery = useInvitations();
  const rolesQuery = useRoles();
  const updateUser = useUpdateUser();

  if (!canManage) {
    return (
      <div>
        <h1 className="text-2xl font-semibold text-ink-900">Users</h1>
        <Card className="mt-8">
          <p className="text-sm text-ink-600">
            You don&apos;t have permission to view organization users. Contact an administrator.
          </p>
        </Card>
      </div>
    );
  }

  const users = usersQuery.data?.data ?? [];
  const pagination = usersQuery.data?.pagination;
  const roles = rolesQuery.data ?? [];

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Users</h1>
          <p className="mt-1 text-sm text-ink-500">Manage who has access to {me?.organization.name}.</p>
        </div>
        <Button onClick={() => setShowInvite(true)}>
          <Plus className="h-4 w-4" /> Invite user
        </Button>
      </div>

      {showInvite && (
        <InviteUserForm roles={roles} onClose={() => setShowInvite(false)} />
      )}

      {invitationsQuery.data && invitationsQuery.data.filter((i) => i.status === 'pending').length > 0 && (
        <Card className="mt-6">
          <h2 className="text-sm font-semibold text-ink-900">Pending invitations</h2>
          <ul className="mt-3 divide-y divide-ink-100">
            {invitationsQuery.data
              .filter((i) => i.status === 'pending')
              .map((inv) => (
                <PendingInvitationRow key={inv.id} invitation={inv} />
              ))}
          </ul>
        </Card>
      )}

      <Card className="mt-6 overflow-hidden !p-0">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink-200 bg-ink-50 text-xs font-semibold uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {usersQuery.isLoading && (
              <tr>
                <td className="px-4 py-6 text-ink-500" colSpan={5}>
                  Loading users...
                </td>
              </tr>
            )}
            {!usersQuery.isLoading && users.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-ink-500" colSpan={5}>
                  No users yet.
                </td>
              </tr>
            )}
            {users.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-3 font-medium text-ink-900">{u.full_name || '—'}</td>
                <td className="px-4 py-3 text-ink-600">{u.email}</td>
                <td className="px-4 py-3">
                  <select
                    className="rounded-md border border-ink-200 bg-white px-2 py-1 text-sm"
                    value={u.roles[0]?.id ?? ''}
                    disabled={u.id === me?.user.id}
                    onChange={(e) =>
                      updateUser.mutate({ id: u.id, role_id: e.target.value })
                    }
                  >
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-3">
                  <Badge tone={u.status === 'active' ? 'success' : 'neutral'}>{u.status}</Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <Button
                    variant="secondary"
                    disabled={u.id === me?.user.id || updateUser.isPending}
                    onClick={() =>
                      updateUser.mutate({
                        id: u.id,
                        status: u.status === 'active' ? 'inactive' : 'active',
                      })
                    }
                  >
                    {u.status === 'active' ? 'Deactivate' : 'Reactivate'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {pagination && pagination.total_pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
          <span>
            Page {pagination.page} of {pagination.total_pages} ({pagination.total} users)
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button
              variant="secondary"
              disabled={page >= pagination.total_pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function InviteUserForm({
  roles,
  onClose,
}: {
  roles: { id: string; name: string }[];
  onClose: () => void;
}): JSX.Element {
  const inviteUser = useInviteUser();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const result = (await inviteUser.mutateAsync({ email, role_id: roleId })) as {
        invite_url: string;
      };
      setInviteUrl(result.invite_url);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not send invitation.');
    }
  }

  return (
    <Card className="relative mt-6">
      <button className="absolute right-4 top-4 text-ink-400 hover:text-ink-700" onClick={onClose} type="button">
        <X className="h-4 w-4" />
      </button>
      <h2 className="text-sm font-semibold text-ink-900">Invite a user</h2>
      {inviteUrl ? (
        <div className="mt-3 space-y-2">
          <Alert variant="success">
            Invitation sent. In Phase 1, invite emails are logged by the backend rather than sent via
            SMTP (that lands in a later phase) - here is the link directly:
          </Alert>
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 flex-shrink-0 text-ink-400" />
            <code className="break-all rounded bg-ink-100 px-2 py-1 text-xs">{inviteUrl}</code>
          </div>
          <Button variant="secondary" onClick={onClose} type="button">
            Done
          </Button>
        </div>
      ) : (
        <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={handleSubmit}>
          {error && (
            <div className="w-full">
              <Alert>{error}</Alert>
            </div>
          )}
          <div className="flex-1 min-w-[220px]">
            <Label htmlFor="invite_email">Email</Label>
            <Input
              id="invite_email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="min-w-[180px]">
            <Label htmlFor="invite_role">Role</Label>
            <select
              id="invite_role"
              className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm"
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              required
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={inviteUser.isPending}>
            {inviteUser.isPending ? 'Sending...' : 'Send invite'}
          </Button>
        </form>
      )}
    </Card>
  );
}

function PendingInvitationRow({
  invitation,
}: {
  invitation: { id: string; email: string; role_name: string | null; expires_at: string };
}): JSX.Element {
  const revoke = useRevokeInvitation();
  return (
    <li className="flex items-center justify-between py-2 text-sm">
      <div>
        <p className="font-medium text-ink-800">{invitation.email}</p>
        <p className="text-xs text-ink-500">
          {invitation.role_name?.replace(/_/g, ' ')} &middot; expires{' '}
          {new Date(invitation.expires_at).toLocaleDateString()}
        </p>
      </div>
      <Button variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(invitation.id)}>
        Revoke
      </Button>
    </li>
  );
}
