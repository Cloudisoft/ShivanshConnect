import { randomUUID } from 'node:crypto';

/**
 * A minimal in-memory fake of the subset of the supabase-js client this
 * backend actually uses (the specific .from()/.select()/.eq()/... chains
 * and .auth.* methods called from src/routes and src/lib). It is not a
 * general SQL engine - it exists only so the integration test below can
 * exercise real route/handler code end-to-end over HTTP (via
 * app.inject()) without a live Supabase project or Docker.
 *
 * This is the documented fallback from the task brief: "mock at the
 * DB-client boundary" because the Supabase CLI's local Docker stack
 * could not pull images in this sandbox (see README's Verification
 * Notes). It does NOT exercise Postgres RLS - that was instead verified
 * separately by applying every migration to a real local PostgreSQL 16
 * instance (see supabase/migrations).
 */

type Row = Record<string, any>;

interface Tables {
  organizations: Row[];
  organization_settings: Row[];
  users: Row[];
  roles: Row[];
  permissions: Row[];
  role_permissions: Row[];
  user_roles: Row[];
  audit_logs: Row[];
  user_invitations: Row[];
  lead_lists: Row[];
  leads: Row[];
  lead_list_members: Row[];
  lead_custom_fields: Row[];
  dnc_entries: Row[];
  import_jobs: Row[];
  import_job_rows: Row[];
}

export interface FakeAuthUser {
  id: string;
  email: string;
  password: string;
}

export function createFakeSupabase() {
  const tables: Tables = {
    organizations: [],
    organization_settings: [],
    users: [],
    roles: [],
    permissions: [],
    role_permissions: [],
    user_roles: [],
    audit_logs: [],
    user_invitations: [],
    lead_lists: [],
    leads: [],
    lead_list_members: [],
    lead_custom_fields: [],
    dnc_entries: [],
    import_jobs: [],
    import_job_rows: [],
  };

  const authUsers = new Map<string, FakeAuthUser>(); // id -> user
  const tokens = new Map<string, string>(); // access_token -> user id

  function seedRolesAndPermissions() {
    const roleNames = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'AGENT', 'VIEWER'];
    for (const name of roleNames) {
      tables.roles.push({
        id: randomUUID(),
        organization_id: null,
        name,
        is_system_role: true,
        created_at: new Date().toISOString(),
      });
    }
    const permKeys = [
      'dashboard.view',
      'users.manage',
      'roles.manage',
      'settings.manage',
      'audit.view',
      'leads.view',
      'leads.create',
      'leads.edit',
      'leads.delete',
      'leads.import',
    ];
    for (const key of permKeys) {
      tables.permissions.push({ id: randomUUID(), key, description: key, category: key.split('.')[0] });
    }
    const superAdmin = tables.roles.find((r) => r.name === 'SUPER_ADMIN')!;
    for (const perm of tables.permissions) {
      tables.role_permissions.push({ role_id: superAdmin.id, permission_id: perm.id });
    }
    const admin = tables.roles.find((r) => r.name === 'ADMIN')!;
    for (const perm of tables.permissions) {
      tables.role_permissions.push({ role_id: admin.id, permission_id: perm.id });
    }
    const viewer = tables.roles.find((r) => r.name === 'VIEWER')!;
    const dashboardPerm = tables.permissions.find((p) => p.key === 'dashboard.view')!;
    tables.role_permissions.push({ role_id: viewer.id, permission_id: dashboardPerm.id });
  }
  seedRolesAndPermissions();

  function matchesClause(actual: any, op: string, value: any): boolean {
    switch (op) {
      case 'eq':
        return actual === value;
      case 'neq':
        return actual !== value;
      case 'in':
        return (value as any[]).includes(actual);
      case 'ilike': {
        const pattern = String(value).replace(/%/g, '').toLowerCase();
        return String(actual ?? '').toLowerCase().includes(pattern);
      }
      case 'is':
        return value === 'null' ? actual === null || actual === undefined : actual === value;
      case 'gte':
        return actual >= value;
      case 'lte':
        return actual <= value;
      default:
        return true;
    }
  }

  function matchesFilters(row: Row, filters: Array<[string, string, any]>): boolean {
    return filters.every(([field, op, value]) => matchesClause(row[field], op, value));
  }

  /**
   * Minimal stand-in for PostgREST's embedded-resource select syntax
   * (e.g. `.select('role_id, roles(id, name)')`), covering only the
   * specific relations this codebase actually selects.
   */
  function embedRelations(table: keyof Tables, row: Row, selectStr: string): Row {
    const out = { ...row };

    const roleObj = (roleId: string | null) => {
      const role = tables.roles.find((r) => r.id === roleId);
      return role ? { id: role.id, name: role.name, is_system_role: role.is_system_role } : null;
    };

    if ((table === 'user_roles' || table === 'user_invitations') && selectStr.includes('roles(')) {
      out.roles = roleObj(row.role_id);
    }

    if (table === 'role_permissions' && selectStr.includes('permissions(')) {
      const perm = tables.permissions.find((p) => p.id === row.permission_id);
      out.permissions = perm ? { key: perm.key } : null;
    }

    if (table === 'lead_list_members' && selectStr.includes('lead_lists(')) {
      const list = tables.lead_lists.find((l) => l.id === row.lead_list_id);
      out.lead_lists = list ? { id: list.id, name: list.name } : null;
    }

    if (table === 'users' && selectStr.includes('user_roles(')) {
      const innerMatch = selectStr.match(/user_roles\(([^)]*)\)/);
      const inner = innerMatch?.[1] ?? '';
      const urs = tables.user_roles.filter((ur) => ur.user_id === row.id);
      out.user_roles = urs.map((ur) => {
        const embedded: Row = { ...ur };
        if (inner.includes('roles(')) embedded.roles = roleObj(ur.role_id);
        return embedded;
      });
    }

    return out;
  }

  function defaultsFor(table: keyof Tables): Row {
    switch (table) {
      case 'organizations':
        return { status: 'active', timezone: 'UTC' };
      case 'users':
        return { status: 'active' };
      case 'user_invitations':
        return {
          status: 'pending',
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        };
      case 'leads':
        return {
          first_name: '',
          last_name: '',
          country_code: 'US',
          country: 'US',
          status: 'NEW',
          attempts: 0,
          is_dnc: false,
          custom_fields: {},
        };
      case 'dnc_entries':
        return { source: 'manual' };
      case 'import_jobs':
        return {
          status: 'pending',
          column_mapping: {},
          total_rows: 0,
          valid_rows: 0,
          invalid_rows: 0,
          duplicate_rows: 0,
          dnc_rows: 0,
          imported_rows: 0,
        };
      case 'lead_custom_fields':
        return { field_type: 'text' };
      default:
        return {};
    }
  }

  class QueryBuilder {
    private table: keyof Tables;
    private filters: Array<[string, string, any]> = [];
    private orFilters: Array<[string, string, any]> | null = null;
    private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    private payload: Row | Row[] | null = null;
    private rangeVal: [number, number] | null = null;
    private wantCount = false;
    private selectStr = '';

    constructor(table: keyof Tables) {
      this.table = table;
    }

    select(cols?: string, opts?: { count?: string; head?: boolean }): this {
      if (this.op === 'select') this.op = 'select';
      this.selectStr = cols ?? '';
      if (opts?.count) this.wantCount = true;
      return this;
    }

    eq(field: string, value: any): this {
      this.filters.push([field, 'eq', value]);
      return this;
    }

    in(field: string, values: any[]): this {
      this.filters.push([field, 'in', values]);
      return this;
    }

    ilike(field: string, value: any): this {
      this.filters.push([field, 'ilike', value]);
      return this;
    }

    gte(field: string, value: any): this {
      this.filters.push([field, 'gte', value]);
      return this;
    }

    lte(field: string, value: any): this {
      this.filters.push([field, 'lte', value]);
      return this;
    }

    or(expr: string): this {
      // Supports the one shape this codebase uses:
      // "is_system_role.eq.true,organization_id.eq.<uuid>"
      this.orFilters = expr.split(',').map((clause) => {
        const [field, op, rawValue] = clause.split('.');
        const value = rawValue === 'true' ? true : rawValue === 'false' ? false : rawValue;
        return [field, op, value] as [string, string, any];
      });
      return this;
    }

    private orderBy: [string, boolean] | null = null;

    order(field: string, opts?: { ascending?: boolean }): this {
      this.orderBy = [field, opts?.ascending !== false];
      return this;
    }

    neq(field: string, value: any): this {
      this.filters.push([field, 'neq', value]);
      return this;
    }

    range(from: number, to: number): this {
      this.rangeVal = [from, to];
      return this;
    }

    insert(payload: Row | Row[]): this {
      this.op = 'insert';
      this.payload = payload;
      return this;
    }

    update(payload: Row): this {
      this.op = 'update';
      this.payload = payload;
      return this;
    }

    delete(): this {
      this.op = 'delete';
      return this;
    }

    private matched(): Row[] {
      let rows = tables[this.table];
      if (this.orFilters) {
        rows = rows.filter((r) => this.orFilters!.some(([f, op, v]) => matchesClause(r[f], op, v)));
      }
      return rows.filter((r) => matchesFilters(r, this.filters));
    }

    private resolve(): { data: any; error: any; count?: number } {
      if (this.op === 'insert') {
        const rowsToInsert = Array.isArray(this.payload) ? this.payload : [this.payload!];
        const inserted = rowsToInsert.map((r) => ({
          id: r.id ?? (this.table === 'role_permissions' ? undefined : randomUUID()),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...defaultsFor(this.table),
          ...r,
        }));
        tables[this.table].push(...inserted);
        return { data: Array.isArray(this.payload) ? inserted : inserted[0], error: null };
      }

      if (this.op === 'update') {
        const rows = this.matched();
        for (const row of rows) Object.assign(row, this.payload, { updated_at: new Date().toISOString() });
        return { data: rows, error: null };
      }

      if (this.op === 'delete') {
        const rows = this.matched();
        tables[this.table] = tables[this.table].filter((r) => !rows.includes(r));
        return { data: rows, error: null };
      }

      // select
      let rows = this.matched();
      const count = rows.length;
      if (this.orderBy) {
        const [field, ascending] = this.orderBy;
        rows = [...rows].sort((a, b) => {
          const av = a[field];
          const bv = b[field];
          if (av === bv) return 0;
          if (av === undefined || av === null) return ascending ? -1 : 1;
          if (bv === undefined || bv === null) return ascending ? 1 : -1;
          return (av > bv ? 1 : -1) * (ascending ? 1 : -1);
        });
      }
      rows = rows.map((r) => embedRelations(this.table, r, this.selectStr));
      if (this.rangeVal) rows = rows.slice(this.rangeVal[0], this.rangeVal[1] + 1);
      return { data: rows, error: null, count: this.wantCount ? count : undefined };
    }

    async maybeSingle(): Promise<{ data: any; error: any }> {
      const { data, error } = this.resolve();
      const rows = Array.isArray(data) ? data : [data];
      return { data: rows[0] ?? null, error };
    }

    async single(): Promise<{ data: any; error: any }> {
      const { data, error } = this.resolve();
      const rows = Array.isArray(data) ? data : [data];
      if (rows.length === 0) return { data: null, error: error ?? { message: 'Not found' } };
      return { data: rows[0], error };
    }

    then(resolve: (value: { data: any; error: any; count?: number }) => any, reject?: (e: any) => any) {
      try {
        resolve(this.resolve());
      } catch (e) {
        if (reject) reject(e);
      }
    }
  }

  const supabase = {
    from(table: keyof Tables) {
      return new QueryBuilder(table);
    },
    auth: {
      async signUp({ email, password }: { email: string; password: string; options?: any }) {
        if ([...authUsers.values()].some((u) => u.email === email)) {
          return { data: { user: null, session: null }, error: { message: 'User already registered' } };
        }
        const id = randomUUID();
        authUsers.set(id, { id, email, password });
        const token = randomUUID();
        tokens.set(token, id);
        return {
          data: {
            user: { id, email },
            session: { access_token: token, refresh_token: `${token}-refresh`, user: { id, email } },
          },
          error: null,
        };
      },
      async signInWithPassword({ email, password }: { email: string; password: string }) {
        const user = [...authUsers.values()].find((u) => u.email === email);
        if (!user || user.password !== password) {
          return { data: { session: null, user: null }, error: { message: 'Invalid credentials' } };
        }
        const token = randomUUID();
        tokens.set(token, user.id);
        return {
          data: {
            session: { access_token: token, refresh_token: `${token}-refresh`, user: { id: user.id } },
            user: { id: user.id, email: user.email },
          },
          error: null,
        };
      },
      async getUser(token: string) {
        const userId = tokens.get(token);
        if (!userId) return { data: { user: null }, error: { message: 'Invalid token' } };
        const user = authUsers.get(userId)!;
        return { data: { user: { id: user.id, email: user.email } }, error: null };
      },
      admin: {
        async createUser({ email, password }: { email: string; password: string }) {
          if ([...authUsers.values()].some((u) => u.email === email)) {
            return { data: { user: null }, error: { message: 'User already registered' } };
          }
          const id = randomUUID();
          authUsers.set(id, { id, email, password });
          return { data: { user: { id, email } }, error: null };
        },
        async deleteUser(id: string) {
          authUsers.delete(id);
          return { data: null, error: null };
        },
        async signOut() {
          return { error: null };
        },
      },
    },
  };

  return { supabase, tables };
}
