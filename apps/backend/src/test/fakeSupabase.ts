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
  ai_agents: Row[];
  ai_agent_versions: Row[];
  ai_agent_improvements: Row[];
  scripts: Row[];
  knowledge_bases: Row[];
  knowledge_documents: Row[];
  knowledge_chunks: Row[];
  voice_providers: Row[];
  voice_provider_credentials: Row[];
  voices: Row[];
  phone_number_providers: Row[];
  phone_number_provider_credentials: Row[];
  phone_numbers: Row[];
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
    ai_agents: [],
    ai_agent_versions: [],
    ai_agent_improvements: [],
    scripts: [],
    knowledge_bases: [],
    knowledge_documents: [],
    knowledge_chunks: [],
    voice_providers: [],
    voice_provider_credentials: [],
    voices: [],
    phone_number_providers: [],
    phone_number_provider_credentials: [],
    phone_numbers: [],
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
      'agents.manage',
      'voices.manage',
      'numbers.manage',
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

  function seedVoiceProviders() {
    const catalog: Array<[string, string, boolean]> = [
      ['elevenlabs', 'ElevenLabs', false],
      ['cartesia', 'Cartesia', false],
      ['omnivoice', 'OmniVoice (k2-fsa)', true],
      ['voxcpm', 'VoxCPM (OpenBMB)', true],
    ];
    for (const [key, display_name, requires_external_hosting] of catalog) {
      tables.voice_providers.push({
        id: randomUUID(),
        organization_id: null,
        key,
        display_name,
        requires_external_hosting,
        created_at: new Date().toISOString(),
      });
    }
  }
  seedVoiceProviders();

  function seedPhoneNumberProviders() {
    const catalog: Array<[string, string]> = [
      ['twilio', 'Twilio'],
      ['telnyx', 'Telnyx'],
      ['byon', 'Bring Your Own Number (BYON)'],
    ];
    for (const [key, display_name] of catalog) {
      tables.phone_number_providers.push({ id: randomUUID(), key, display_name, created_at: new Date().toISOString() });
    }
  }
  seedPhoneNumberProviders();

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
      case 'ai_agents':
        return { status: 'draft', current_version_id: null };
      case 'ai_agent_versions':
        return {
          personality: { tone: null, personality_traits: [], behavior_traits: [] },
          language: 'en-US',
          greeting_template: '',
          system_prompt: '',
          transfer_rules: { on_no_match: 'end_call', transfer_to: null, conditions: [] },
          call_ending_rules: { max_call_duration_seconds: null, end_phrases: [], summarize_before_ending: true },
          llm_provider: 'openai',
          llm_model: 'gpt-4o-mini',
          llm_temperature: 0.7,
          llm_max_tokens: 800,
          status: 'draft',
        };
      case 'scripts':
        return { version: 1, source: 'editor' };
      case 'knowledge_documents':
        return { status: 'uploaded', size_bytes: 0 };
      case 'voice_provider_credentials':
        return { status: 'not_connected', last_verified_at: null, last_error: null };
      case 'voices':
        return {
          gender: 'unknown',
          status: 'active',
          is_cloned: false,
          clone_status: 'n/a',
          consent_confirmed: false,
        };
      case 'phone_number_provider_credentials':
        return { status: 'not_connected', last_synced_at: null, last_error: null };
      case 'phone_numbers':
        return {
          provider_number_id: null,
          friendly_name: null,
          capabilities: { voice_inbound: true, voice_outbound: true, sms: false },
          status: 'active',
          assigned_agent_id: null,
          assigned_campaign_id: null,
          sip_trunk_metadata: null,
        };
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

  /**
   * Minimal stand-in for supabase.rpc('match_knowledge_chunks', ...) -
   * the one Postgres function this codebase calls (see
   * supabase/migrations/00000000000023_knowledge_chunk_search_fn.sql).
   * Computes cosine similarity in JS against the in-memory
   * knowledge_chunks table, with the exact same organization_id (and
   * optional agent_id, via each chunk's document -> knowledge_base
   * chain) scoping the real SQL function applies - this is what lets
   * the cross-org retrieval isolation test exercise real route code
   * without a live Postgres/pgvector instance.
   */
  function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  function matchKnowledgeChunks(args: {
    query_embedding: number[];
    match_organization_id: string;
    match_agent_id?: string | null;
    match_count?: number;
  }): { data: Row[]; error: null } {
    const { query_embedding: queryEmbedding, match_organization_id: orgId, match_agent_id: agentId, match_count: count = 5 } = args;

    const scored = tables.knowledge_chunks
      .filter((chunk) => chunk.organization_id === orgId && chunk.embedding)
      .map((chunk) => {
        const doc = tables.knowledge_documents.find((d) => d.id === chunk.document_id);
        const kb = doc ? tables.knowledge_bases.find((k) => k.id === doc.knowledge_base_id) : undefined;
        return { chunk, doc, kb };
      })
      .filter(({ doc, kb }) => {
        if (!doc || doc.organization_id !== orgId) return false;
        if (!kb || kb.organization_id !== orgId) return false;
        if (agentId && kb.agent_id !== agentId) return false;
        return true;
      })
      .map(({ chunk }) => ({
        id: chunk.id,
        document_id: chunk.document_id,
        chunk_index: chunk.chunk_index,
        content: chunk.content,
        similarity: cosineSimilarity(queryEmbedding, chunk.embedding as number[]),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, count);

    return { data: scored, error: null };
  }

  const supabase = {
    from(table: keyof Tables) {
      return new QueryBuilder(table);
    },
    async rpc(fnName: string, args: Record<string, any>) {
      if (fnName === 'match_knowledge_chunks') {
        return matchKnowledgeChunks(args as any);
      }
      return { data: null, error: { message: `Unknown RPC function in fake client: ${fnName}` } };
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
