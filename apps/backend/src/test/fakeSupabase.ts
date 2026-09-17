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
  vapi_credentials: Row[];
  calls: Row[];
  call_events: Row[];
  webhook_events: Row[];
  webhook_failures: Row[];
  campaigns: Row[];
  campaign_versions: Row[];
  campaign_leads: Row[];
  campaign_lead_skip_log: Row[];
  campaign_settings: Row[];
  dialing_settings: Row[];
  dispositions: Row[];
  call_dispositions: Row[];
  callbacks: Row[];
  call_transcripts: Row[];
  call_transcript_segments: Row[];
  call_recordings: Row[];
  call_summaries: Row[];
  exports: Row[];
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
    vapi_credentials: [],
    calls: [],
    call_events: [],
    webhook_events: [],
    webhook_failures: [],
    campaigns: [],
    campaign_versions: [],
    campaign_leads: [],
    campaign_lead_skip_log: [],
    campaign_settings: [],
    dialing_settings: [],
    dispositions: [],
    call_dispositions: [],
    callbacks: [],
    call_transcripts: [],
    call_transcript_segments: [],
    call_recordings: [],
    call_summaries: [],
    exports: [],
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
      'calls.manage',
      'webhooks.manage',
      'cdr.view',
      'campaigns.view',
      'campaigns.create',
      'campaigns.edit',
      'campaigns.start',
      'campaigns.pause',
      'campaigns.delete',
      'callbacks.manage',
      'cdr.export',
      // Phase 10: live_monitor.* - mirrors
      // 00000000000009_seed_roles_permissions.sql's real catalog/role
      // mapping exactly (MANAGER gets everything except roles/users/
      // settings management, which includes these; AGENT gets
      // live_monitor.view only) so permission-gating tests against this
      // harness reflect the real seeded tiers.
      'live_monitor.view',
      'live_monitor.listen',
      'live_monitor.barge',
      'live_monitor.whisper',
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
    // MANAGER: everything except role/user/settings-level administration
    // (real seed migration's exact carve-out).
    const manager = tables.roles.find((r) => r.name === 'MANAGER')!;
    for (const perm of tables.permissions) {
      if (['roles.manage', 'users.manage', 'settings.manage'].includes(perm.key)) continue;
      tables.role_permissions.push({ role_id: manager.id, permission_id: perm.id });
    }
    // AGENT: day-to-day operational permissions only (real seed
    // migration's exact list, trimmed to keys this fixture actually
    // seeds).
    const agent = tables.roles.find((r) => r.name === 'AGENT')!;
    for (const key of ['dashboard.view', 'campaigns.view', 'leads.view', 'live_monitor.view', 'cdr.view']) {
      const perm = tables.permissions.find((p) => p.key === key);
      if (perm) tables.role_permissions.push({ role_id: agent.id, permission_id: perm.id });
    }
    const viewer = tables.roles.find((r) => r.name === 'VIEWER')!;
    for (const key of ['dashboard.view', 'campaigns.view', 'leads.view', 'live_monitor.view', 'cdr.view']) {
      const perm = tables.permissions.find((p) => p.key === key);
      if (perm) tables.role_permissions.push({ role_id: viewer.id, permission_id: perm.id });
    }
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

  function seedDispositions() {
    const catalog: Array<[string, string]> = [
      ['CALL_CONNECTED', 'Call Connected'],
      ['DISCONNECTED', 'Disconnected'],
      ['DNC', 'DNC'],
      ['ANSWERING_MACHINE', 'Answering Machine'],
      ['VOICEMAIL', 'Voicemail'],
      ['NOT_INTERESTED', 'Not Interested'],
      ['HUNG_UP', 'Hung Up'],
      ['TRANSFERRED', 'Transferred'],
      ['CALL_DISCONNECTED_IN_TRANSFER', 'Call Disconnected in Transfer'],
    ];
    for (const [code, name] of catalog) {
      tables.dispositions.push({ id: randomUUID(), organization_id: null, code, name, is_system: true, created_at: new Date().toISOString() });
    }
  }
  seedDispositions();

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
      case 'gt':
        return actual > value;
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

    if (table === 'campaign_leads' && selectStr.includes('leads(')) {
      const lead = tables.leads.find((l) => l.id === row.lead_id);
      out.leads = lead ? { id: lead.id, first_name: lead.first_name, last_name: lead.last_name, phone_normalized: lead.phone_normalized, company: lead.company } : null;
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
      case 'vapi_credentials':
        return { status: 'not_connected', last_verified_at: null, last_error: null, webhook_url: null };
      case 'calls':
        return {
          vapi_call_id: null,
          pipecat_call_id: null,
          campaign_id: null,
          lead_id: null,
          status: 'queued',
          started_at: null,
          answered_at: null,
          ended_at: null,
          duration_seconds: null,
          talk_duration_seconds: null,
          ended_reason: null,
          transfer_destination_e164: null,
          transfer_status: null,
          cost: null,
        };
      case 'webhook_events':
        return { organization_id: null, processed_at: null, processing_status: 'pending', error: null, retry_count: 0, received_at: new Date().toISOString() };
      case 'webhook_failures':
        return { replayed_at: null, failed_at: new Date().toISOString() };
      case 'campaigns':
        return {
          status: 'draft',
          timezone: 'America/New_York',
          calling_window_start: '09:00',
          calling_window_end: '18:00',
          calling_days: [1, 2, 3, 4, 5],
          concurrency_limit: 5,
          calls_per_minute_limit: null,
          current_version_id: null,
          phone_number_id: null,
          transfer_number_e164: null,
          voicemail_detection_enabled: true,
          voicemail_message: null,
          leave_voicemail: true,
          lead_cooldown_minutes: 1440,
          background_noise: null,
        };
      case 'campaign_versions':
        return {
          prompt: '',
          ai_agent_id: null,
          ai_agent_version_id: null,
          voice_id: null,
          knowledge_base_ids: [],
          script_id: null,
          transfer_number_e164: null,
          calling_rules: {},
          disposition_rules: {},
          status: 'draft',
          published_at: null,
        };
      case 'campaign_leads':
        return {
          status: 'pending',
          attempt_count: 0,
          last_attempt_at: null,
          next_eligible_at: null,
          last_call_id: null,
          final_disposition: null,
          added_at: new Date().toISOString(),
        };
      case 'dialing_settings':
        return {
          is_default: true,
          default_concurrency: 5,
          max_concurrency: 25,
          calls_per_minute: 30,
          max_attempts: 3,
          retry_delay_minutes: 60,
          lead_cooldown_minutes: 1440,
          calling_hours_start: '09:00',
          calling_hours_end: '18:00',
          voicemail_behavior: 'leave_message',
          amd_enabled: true,
          dnc_behavior: 'skip',
          failed_call_behavior: 'retry',
          busy_behavior: 'retry',
          no_answer_behavior: 'retry',
        };
      case 'call_transcripts':
        return { full_text: null, status: 'pending', failure_reason: null, source_url: null };
      case 'call_recordings':
        return {
          provider_recording_url: null,
          storage_path: null,
          format: null,
          duration_seconds: null,
          size_bytes: null,
          status: 'pending',
          failure_reason: null,
        };
      case 'call_summaries':
        return { key_points: [], customer_intent: null, objections: null, questions: null, next_action: null, outcome: null, generated_at: new Date().toISOString() };
      case 'exports':
        return { filters: {}, status: 'pending', file_storage_path: null, row_count: null, failure_reason: null, completed_at: null };
      default:
        return {};
    }
  }

  /**
   * Tables that carry a real UNIQUE index in the migrations, whose
   * enforcement the Phase 6 webhook-idempotency test relies on being
   * simulated here too (a replayed identical delivery must fail to
   * insert a second row) - see 00000000000028_orchestration_calls.sql's
   * `webhook_events_provider_event_id_key`. Each entry is the list of
   * columns whose combined value must be unique among existing rows;
   * a row where any of those columns is null is exempt (mirrors a
   * partial/nullable unique index), matching every other partial unique
   * index in this schema.
   */
  const UNIQUE_CONSTRAINTS: Partial<Record<keyof Tables, string[][]>> = {
    webhook_events: [['provider', 'event_id']],
    // Phase 10: mirrors call_transcript_segments_transcript_index_key
    // (00000000000035_phase9_cdr.sql) - the real dedupe key live
    // transcript ingestion relies on (services/liveTranscriptIngestion.ts).
    call_transcript_segments: [['transcript_id', 'segment_index']],
  };

  function violatesUniqueConstraint(table: keyof Tables, candidate: Row): boolean {
    const constraints = UNIQUE_CONSTRAINTS[table];
    if (!constraints) return false;
    return constraints.some((cols) => {
      if (cols.some((c) => candidate[c] === null || candidate[c] === undefined)) return false;
      return tables[table].some((existing) => cols.every((c) => existing[c] === candidate[c]));
    });
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

    is(field: string, value: any): this {
      this.filters.push([field, 'is', value]);
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

    gt(field: string, value: any): this {
      this.filters.push([field, 'gt', value]);
      return this;
    }

    lte(field: string, value: any): this {
      this.filters.push([field, 'lte', value]);
      return this;
    }

    or(expr: string): this {
      // Supports the shapes this codebase uses, e.g.
      // "is_system_role.eq.true,organization_id.eq.<uuid>" or
      // "next_eligible_at.is.null,next_eligible_at.lte.<ISO timestamp>".
      // Splits on only the FIRST TWO dots - an ISO timestamp value itself
      // contains a dot before its milliseconds (and the field/op never
      // do), so a naive full split() would truncate it.
      this.orFilters = expr.split(',').map((clause) => {
        const firstDot = clause.indexOf('.');
        const secondDot = clause.indexOf('.', firstDot + 1);
        const field = clause.slice(0, firstDot);
        const op = clause.slice(firstDot + 1, secondDot);
        const rawValue = clause.slice(secondDot + 1);
        const value = rawValue === 'true' ? true : rawValue === 'false' ? false : rawValue === 'null' ? null : rawValue;
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

    limit(n: number): this {
      this.rangeVal = [0, n - 1];
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
        for (const row of inserted) {
          if (violatesUniqueConstraint(this.table, row)) {
            // Mirrors PostgREST's real shape closely enough for route
            // code to detect (error.code === '23505') - see
            // routes/webhooks.ts's recordWebhookEvent().
            return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint on ${this.table}` } };
          }
        }
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

  /**
   * Minimal stand-in for supabase.rpc('search_call_transcripts', ...) -
   * see supabase/migrations/00000000000035_phase9_cdr.sql. Ranks by a
   * simple case-insensitive occurrence count rather than real
   * ts_rank/tsvector math (that's the whole point of only running this
   * against real Postgres for the actual SQL - see README's Verification
   * Notes), but applies the exact same org-scoping + "only ready
   * transcripts" + "must actually match" filters the real function does,
   * which is what the cross-org isolation and correctness tests exercise.
   */
  function searchCallTranscripts(args: { search_query: string; match_organization_id: string; match_count?: number; match_offset?: number }): { data: Row[]; error: null } {
    const { search_query: query, match_organization_id: orgId, match_count: count = 20, match_offset: offset = 0 } = args;
    const needle = query.trim().toLowerCase();
    const scored = tables.call_transcripts
      .filter((t) => t.organization_id === orgId && t.status === 'ready' && typeof t.full_text === 'string')
      .map((t) => {
        const haystack = String(t.full_text).toLowerCase();
        const occurrences = needle.length === 0 ? 0 : haystack.split(needle).length - 1;
        return { transcript_id: t.id, call_id: t.call_id, full_text: t.full_text, rank: occurrences };
      })
      .filter((r) => r.rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .slice(offset, offset + count);
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
      if (fnName === 'search_call_transcripts') {
        return searchCallTranscripts(args as any);
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
