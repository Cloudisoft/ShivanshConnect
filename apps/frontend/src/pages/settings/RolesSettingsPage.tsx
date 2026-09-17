import { useMemo, useState, type FormEvent } from 'react';
import { Lock, Plus, Trash2, X } from 'lucide-react';
import { useRoles, type RoleWithPermissions } from '../../hooks/useUsers';
import { useCreateRole, useDeleteRole, usePermissionCatalog, useUpdateRole } from '../../hooks/useRoleAdmin';
import { Alert, Badge, Button, Card, Input, Label } from '../../components/ui';
import { ApiClientError } from '../../lib/apiClient';

export function RolesSettingsPage(): JSX.Element {
  const rolesQuery = useRoles();
  const catalogQuery = usePermissionCatalog();
  const [creating, setCreating] = useState(false);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);

  const catalogByCategory = useMemo(() => {
    const groups = new Map<string, { key: string; description: string }[]>();
    for (const p of catalogQuery.data ?? []) {
      const list = groups.get(p.category) ?? [];
      list.push({ key: p.key, description: p.description });
      groups.set(p.category, list);
    }
    return groups;
  }, [catalogQuery.data]);

  const roles = rolesQuery.data ?? [];
  const editingRole = roles.find((r) => r.id === editingRoleId) ?? null;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-ink-900">Roles</h2>
          <p className="mt-1 text-sm text-ink-500">
            The 5 system roles ship fixed. Create custom roles for your organization with any
            combination of permissions.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New role
        </Button>
      </div>

      {creating && (
        <RoleForm
          catalogByCategory={catalogByCategory}
          onClose={() => setCreating(false)}
          mode="create"
        />
      )}

      {editingRole && (
        <RoleForm
          catalogByCategory={catalogByCategory}
          onClose={() => setEditingRoleId(null)}
          mode="edit"
          role={editingRole}
        />
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {roles.map((role) => (
          <RoleCard key={role.id} role={role} onEdit={() => setEditingRoleId(role.id)} />
        ))}
      </div>
    </div>
  );
}

function RoleCard({ role, onEdit }: { role: RoleWithPermissions; onEdit: () => void }): JSX.Element {
  const deleteRole = useDeleteRole();
  const [error, setError] = useState<string | null>(null);

  return (
    <Card>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-ink-900">{role.name.replace(/_/g, ' ')}</h3>
            {role.is_system_role && (
              <Badge>
                <Lock className="mr-1 inline h-3 w-3" /> system
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-ink-500">{role.permissions.length} permissions</p>
        </div>
        {!role.is_system_role && (
          <div className="flex gap-1">
            <Button variant="ghost" onClick={onEdit}>
              Edit
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                setError(null);
                try {
                  await deleteRole.mutateAsync(role.id);
                } catch (err) {
                  setError(err instanceof ApiClientError ? err.message : 'Could not delete role.');
                }
              }}
            >
              <Trash2 className="h-4 w-4 text-red-600" />
            </Button>
          </div>
        )}
      </div>
      {error && (
        <div className="mt-2">
          <Alert>{error}</Alert>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-1">
        {role.permissions.slice(0, 6).map((p) => (
          <Badge key={p}>{p}</Badge>
        ))}
        {role.permissions.length > 6 && <Badge>+{role.permissions.length - 6} more</Badge>}
      </div>
    </Card>
  );
}

function RoleForm({
  catalogByCategory,
  onClose,
  mode,
  role,
}: {
  catalogByCategory: Map<string, { key: string; description: string }[]>;
  onClose: () => void;
  mode: 'create' | 'edit';
  role?: RoleWithPermissions;
}): JSX.Element {
  const createRole = useCreateRole();
  const updateRole = useUpdateRole();
  const [name, setName] = useState(role?.name ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [error, setError] = useState<string | null>(null);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (mode === 'create') {
        await createRole.mutateAsync({ name, permission_keys: Array.from(selected) });
      } else if (role) {
        await updateRole.mutateAsync({ id: role.id, name, permission_keys: Array.from(selected) });
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not save this role.');
    }
  }

  const pending = createRole.isPending || updateRole.isPending;

  return (
    <Card className="relative mt-6">
      <button className="absolute right-4 top-4 text-ink-400 hover:text-ink-700" onClick={onClose} type="button">
        <X className="h-4 w-4" />
      </button>
      <h3 className="text-sm font-semibold text-ink-900">
        {mode === 'create' ? 'Create role' : `Edit ${role?.name.replace(/_/g, ' ')}`}
      </h3>
      <form className="mt-4 space-y-4" onSubmit={handleSubmit}>
        {error && <Alert>{error}</Alert>}
        <div className="max-w-sm">
          <Label htmlFor="role_name">Role name</Label>
          <Input id="role_name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
        </div>
        <div>
          <Label>Permissions</Label>
          <div className="mt-2 grid max-h-80 gap-4 overflow-y-auto rounded-md border border-ink-200 p-4 sm:grid-cols-2">
            {Array.from(catalogByCategory.entries()).map(([category, perms]) => (
              <div key={category}>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{category}</p>
                <div className="mt-1 space-y-1">
                  {perms.map((p) => (
                    <label key={p.key} className="flex items-center gap-2 text-sm text-ink-700">
                      <input
                        type="checkbox"
                        checked={selected.has(p.key)}
                        onChange={() => toggle(p.key)}
                        className="h-4 w-4 rounded border-ink-300"
                      />
                      {p.key}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving...' : 'Save role'}
        </Button>
      </form>
    </Card>
  );
}
