/**
 * Phase 15: a real-Postgres-backed stand-in for the small subset of the
 * supabase-js chainable query builder this backend's production code
 * actually calls (see src/test/fakeSupabase.ts's header comment for the
 * equivalent in-memory version used by every OTHER phase's integration
 * tests).
 *
 * WHY THIS EXISTS: `getSupabaseAdmin()` returns a real `@supabase/supabase-
 * js` client that talks PostgREST over HTTP. This sandbox has a real local
 * PostgreSQL 16 instance (see the loadtest README) but no PostgREST server
 * in front of it. Rather than mock the dispatcher/eligibility/disposition/
 * state-machine modules themselves (which would prove nothing about the
 * real system), this adapter implements the EXACT SAME chainable call
 * shape those modules already use (`.from(table).select(...).eq(...)...`)
 * but compiles each chain into real parameterized SQL and executes it
 * against a real Postgres connection pool. Every row read/written here is
 * a genuine round trip to genuine Postgres tables created by the actual
 * `supabase/migrations/*.sql` files - real indexes, real constraints, real
 * UNIQUE violations, real row-level UPDATE locking for the CAS claim.
 *
 * This is loaded ONLY by the load-test suite, via `vi.mock('../lib/
 * supabase.js', ...)` exactly the same way every other integration test in
 * this repo swaps in `fakeSupabase` - see campaigns.integration.test.ts.
 * Production code (`getSupabaseAdmin()` itself) is never changed; this
 * file is never imported outside `src/loadtest/**`.
 *
 * Deliberately NOT a general SQL engine: it supports exactly the filter/
 * select/insert/update/delete/rpc shapes this codebase's routes and
 * services actually issue (verified by grep across the whole backend
 * before writing this - see the Phase 15 final report for the exact
 * list), the same "just enough of the real interface" scope fakeSupabase
 * documents for its own equivalent.
 */
import pg from 'pg';

export type Row = Record<string, any>;

type FilterOp = 'eq' | 'neq' | 'in' | 'ilike' | 'is' | 'gte' | 'gt' | 'lte' | 'lt';
type Filter = [string, FilterOp, any];

/** Values that must be sent to Postgres as jsonb (every "array/object
 * shaped" column in this schema is declared `jsonb`, never a native
 * Postgres array - see supabase/migrations/00000000000031_campaigns.sql's
 * `calling_days jsonb` for the representative example). Dates are passed
 * through as-is (node-postgres already understands ISO strings for
 * timestamptz columns). */
function isJsonValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return true;
  if (typeof v === 'object' && !(v instanceof Date)) return true;
  return false;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

class SqlParams {
  values: any[] = [];
  push(value: unknown): string {
    if (isJsonValue(value)) {
      this.values.push(JSON.stringify(value));
      return `$${this.values.length}::jsonb`;
    }
    this.values.push(value);
    return `$${this.values.length}`;
  }

  /** Pushes a plain array parameter (for `= ANY($n::uuid[]|text[])`)
   * without going through `push()`'s jsonb auto-detection - node-postgres
   * natively encodes a JS array as a real Postgres array parameter. */
  pushArray(values: unknown[]): string {
    this.values.push(values);
    return `$${this.values.length}`;
  }
}

function buildFilterSql(filter: Filter, params: SqlParams): string {
  const [field, op, value] = filter;
  const col = quoteIdent(field);
  switch (op) {
    case 'eq':
      return `${col} = ${params.push(value)}`;
    case 'neq':
      return `${col} <> ${params.push(value)}`;
    case 'in': {
      if (!Array.isArray(value) || value.length === 0) return 'false';
      // A bare untyped array parameter can't be inferred as the right-hand
      // side of ANY() by Postgres's parameter-type inference, so it needs
      // an explicit cast - but this table's "in" filters hit both uuid
      // columns (id/lead_id/campaign_id, e.g. leadEligibility's dispatch
      // query) and plain text columns (status). Casting a uuid COLUMN to
      // text would silently defeat its btree index (exactly the
      // regression the Phase 15 EXPLAIN ANALYZE check exists to catch), so
      // this infers the array's own element type from its values instead
      // of ever touching the column side: every value looking like a
      // UUID casts the array to ::uuid[] (column stays untouched, index
      // still usable); anything else casts to ::text[].
      const looksLikeUuid = value.every((v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
      const castType = looksLikeUuid ? 'uuid' : 'text';
      return `${col} = ANY(${params.pushArray(value)}::${castType}[])`;
    }
    case 'ilike':
      return `${col} ILIKE ${params.push(String(value).replace(/%/g, '%'))}`;
    case 'is':
      if (value === null) return `${col} IS NULL`;
      if (value === true) return `${col} IS TRUE`;
      if (value === false) return `${col} IS FALSE`;
      return `${col} IS ${params.push(value)}`;
    case 'gte':
      return `${col} >= ${params.push(value)}`;
    case 'gt':
      return `${col} > ${params.push(value)}`;
    case 'lte':
      return `${col} <= ${params.push(value)}`;
    case 'lt':
      return `${col} < ${params.push(value)}`;
    default:
      throw new Error(`Unsupported filter op in loadtest pg adapter: ${op}`);
  }
}

/** Parses the exact `.or("field.op.value,field.op.value")` shape this
 * codebase uses (see leadEligibility usage in campaignDispatcher.ts) -
 * mirrors fakeSupabase's own parser (splitting on only the first two dots
 * so an ISO timestamp value's own dots are never mis-split). */
function parseOrExpr(expr: string): Filter[] {
  return expr.split(',').map((clause) => {
    const firstDot = clause.indexOf('.');
    const secondDot = clause.indexOf('.', firstDot + 1);
    const field = clause.slice(0, firstDot);
    const op = clause.slice(firstDot + 1, secondDot) as FilterOp;
    const rawValue = clause.slice(secondDot + 1);
    const value = rawValue === 'true' ? true : rawValue === 'false' ? false : rawValue === 'null' ? null : rawValue;
    return [field, op, value] as Filter;
  });
}

/** The handful of PostgREST embedded-resource selects this codebase's
 * production code actually issues (verified by grep - see this file's
 * header). Each entry says: for a base row from `table`, which extra
 * queries to run and how to attach the result under `alias`. */
const EMBED_HANDLERS: Partial<Record<string, Array<{ selectStr: RegExp; run: (pool: pg.Pool, row: Row) => Promise<void> }>>> = {
  user_roles: [
    {
      selectStr: /roles\(/,
      run: async (pool, row) => {
        const { rows } = await pool.query('SELECT id, name, is_system_role FROM public.roles WHERE id = $1', [row.role_id]);
        row.roles = rows[0] ?? null;
      },
    },
  ],
  role_permissions: [
    {
      selectStr: /permissions\(/,
      run: async (pool, row) => {
        const { rows } = await pool.query('SELECT key FROM public.permissions WHERE id = $1', [row.permission_id]);
        row.permissions = rows[0] ?? null;
      },
    },
  ],
};

class QueryBuilder {
  private filters: Filter[] = [];
  private orFilters: Filter[] | null = null;
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: Row | Row[] | null = null;
  private rangeVal: [number, number] | null = null;
  private wantCount = false;
  private selectStr = '';
  private orderField: [string, boolean] | null = null;

  constructor(private pool: pg.Pool, private table: string) {}

  select(cols?: string, opts?: { count?: string; head?: boolean }): this {
    this.selectStr = cols ?? '*';
    if (opts?.count) this.wantCount = true;
    return this;
  }

  eq(field: string, value: any): this {
    this.filters.push([field, 'eq', value]);
    return this;
  }

  neq(field: string, value: any): this {
    this.filters.push([field, 'neq', value]);
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

  is(field: string, value: any): this {
    this.filters.push([field, 'is', value]);
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

  lt(field: string, value: any): this {
    this.filters.push([field, 'lt', value]);
    return this;
  }

  or(expr: string): this {
    this.orFilters = parseOrExpr(expr);
    return this;
  }

  order(field: string, opts?: { ascending?: boolean }): this {
    this.orderField = [field, opts?.ascending !== false];
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

  private whereSql(params: SqlParams): string {
    const clauses: string[] = this.filters.map((f) => buildFilterSql(f, params));
    if (this.orFilters) {
      const orSql = this.orFilters.map((f) => buildFilterSql(f, params)).join(' OR ');
      clauses.push(`(${orSql})`);
    }
    return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  }

  /** Splits a PostgREST select string into flat top-level columns (never
   * descending into an embedded `relation(...)` group) - e.g.
   * "role_id, roles(id, name)" -> ["role_id"]. Embeds are resolved
   * separately via EMBED_HANDLERS. `"*"` or an empty string selects every
   * real column. */
  private flatColumns(): string[] {
    if (!this.selectStr || this.selectStr.trim() === '' || this.selectStr.trim() === '*') return ['*'];
    const out: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of this.selectStr) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        out.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) out.push(current.trim());
    return out.filter((c) => !c.includes('('));
  }

  private async attachEmbeds(rows: Row[]): Promise<void> {
    const handlers = EMBED_HANDLERS[this.table];
    if (!handlers) return;
    for (const handler of handlers) {
      if (!handler.selectStr.test(this.selectStr)) continue;
      await Promise.all(rows.map((row) => handler.run(this.pool, row)));
    }
  }

  private async resolveSelect(): Promise<{ data: any; error: any; count?: number }> {
    const params = new SqlParams();
    const cols = this.flatColumns();
    const colsSql = cols[0] === '*' ? '*' : cols.map(quoteIdent).join(', ');
    const where = this.whereSql(params);
    let sql = `SELECT ${colsSql} FROM public.${quoteIdent(this.table)} ${where}`;
    if (this.orderField) {
      const [field, ascending] = this.orderField;
      sql += ` ORDER BY ${quoteIdent(field)} ${ascending ? 'ASC' : 'DESC'} NULLS ${ascending ? 'FIRST' : 'LAST'}`;
    }
    if (this.rangeVal) {
      const [from, to] = this.rangeVal;
      sql += ` LIMIT ${to - from + 1} OFFSET ${from}`;
    }
    try {
      const result = await this.pool.query(sql, params.values);
      let count: number | undefined;
      if (this.wantCount) {
        const countParams = new SqlParams();
        const countWhere = this.whereSql(countParams);
        const countRes = await this.pool.query(`SELECT COUNT(*)::int AS c FROM public.${quoteIdent(this.table)} ${countWhere}`, countParams.values);
        count = countRes.rows[0]?.c ?? 0;
      }
      await this.attachEmbeds(result.rows);
      return { data: result.rows, error: null, count };
    } catch (err) {
      return { data: null, error: pgErrorShape(err) };
    }
  }

  private async resolveInsert(): Promise<{ data: any; error: any }> {
    const rowsToInsert = Array.isArray(this.payload) ? this.payload : [this.payload!];
    if (rowsToInsert.length === 0) return { data: [], error: null };
    // Every row in one INSERT must share the same column set (true for
    // every call site in this codebase - each insert() call passes
    // uniformly-shaped objects).
    const columns = Object.keys(rowsToInsert[0]);
    const params = new SqlParams();
    const valueTuples = rowsToInsert.map((row) => `(${columns.map((c) => params.push(row[c])).join(', ')})`);
    const sql = `INSERT INTO public.${quoteIdent(this.table)} (${columns.map(quoteIdent).join(', ')}) VALUES ${valueTuples.join(', ')} RETURNING *`;
    try {
      const result = await this.pool.query(sql, params.values);
      return { data: Array.isArray(this.payload) ? result.rows : result.rows[0], error: null };
    } catch (err) {
      return { data: null, error: pgErrorShape(err) };
    }
  }

  private async resolveUpdate(): Promise<{ data: any; error: any }> {
    const params = new SqlParams();
    const setCols = Object.keys(this.payload as Row);
    const setSql = setCols.map((c) => `${quoteIdent(c)} = ${params.push((this.payload as Row)[c])}`).join(', ');
    const where = this.whereSql(params);
    const sql = `UPDATE public.${quoteIdent(this.table)} SET ${setSql} ${where} RETURNING *`;
    try {
      const result = await this.pool.query(sql, params.values);
      return { data: result.rows, error: null };
    } catch (err) {
      return { data: null, error: pgErrorShape(err) };
    }
  }

  private async resolveDelete(): Promise<{ data: any; error: any }> {
    const params = new SqlParams();
    const where = this.whereSql(params);
    const sql = `DELETE FROM public.${quoteIdent(this.table)} ${where} RETURNING *`;
    try {
      const result = await this.pool.query(sql, params.values);
      return { data: result.rows, error: null };
    } catch (err) {
      return { data: null, error: pgErrorShape(err) };
    }
  }

  private async resolve(): Promise<{ data: any; error: any; count?: number }> {
    if (this.op === 'insert') return this.resolveInsert();
    if (this.op === 'update') return this.resolveUpdate();
    if (this.op === 'delete') return this.resolveDelete();
    return this.resolveSelect();
  }

  async maybeSingle(): Promise<{ data: any; error: any }> {
    const { data, error } = await this.resolve();
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    return { data: rows[0] ?? null, error };
  }

  async single(): Promise<{ data: any; error: any }> {
    const { data, error } = await this.resolve();
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    if (rows.length === 0) return { data: null, error: error ?? { message: 'Not found' } };
    return { data: rows[0], error };
  }

  then(resolve: (value: { data: any; error: any; count?: number }) => any, reject?: (e: any) => any): any {
    return this.resolve().then(resolve, reject);
  }
}

function pgErrorShape(err: unknown): { code: string | null; message: string } {
  const e = err as { code?: string; message?: string };
  // Postgres's real unique_violation SQLSTATE is 23505 - identical code to
  // what PostgREST forwards, so routes/webhooks.ts's `error.code ===
  // '23505'` check works unmodified against this adapter too.
  return { code: e.code ?? null, message: e.message ?? String(err) };
}

export interface PgSupabaseAdapter {
  pool: pg.Pool;
  supabase: {
    from(table: string): QueryBuilder;
    rpc(fnName: string, args: Record<string, any>): Promise<{ data: any; error: any }>;
  };
  close(): Promise<void>;
}

/** Real Postgres functions this codebase calls via `.rpc()` - every one of
 * them already exists as a genuine SQL function created by the real
 * migrations (see supabase/migrations/*_fns.sql). Called here with
 * PostgreSQL's named-argument call syntax so argument order never matters
 * and matches the exact key names each function declares. */
const RPC_ARG_ORDER: Record<string, string[]> = {
  match_knowledge_chunks: ['query_embedding', 'match_organization_id', 'match_agent_id', 'match_count'],
  search_call_transcripts: ['search_query', 'match_organization_id', 'match_count', 'match_offset'],
  agent_evaluation_summary: ['match_organization_id', 'match_agent_id', 'match_since'],
  recompute_analytics_daily_org: ['p_org_id', 'p_date'],
  recompute_analytics_daily_campaign: ['p_org_id', 'p_date'],
  recompute_analytics_daily_agent: ['p_org_id', 'p_date'],
  recompute_analytics_hourly_org: ['p_org_id', 'p_hour'],
  dashboard_disposition_breakdown: ['match_organization_id', 'match_from', 'match_to'],
};

export function createPgSupabaseAdapter(connectionString: string): PgSupabaseAdapter {
  const pool = new pg.Pool({ connectionString, max: 20 });

  async function rpc(fnName: string, args: Record<string, any>): Promise<{ data: any; error: any }> {
    const argOrder = RPC_ARG_ORDER[fnName];
    if (!argOrder) return { data: null, error: { message: `Unknown RPC function in loadtest pg adapter: ${fnName}` } };
    const params = new SqlParams();
    const namedArgs = argOrder
      .filter((name) => name in args)
      .map((name) => `${name} => ${params.push(args[name])}`)
      .join(', ');
    try {
      const result = await pool.query(`SELECT * FROM public.${fnName}(${namedArgs})`, params.values);
      return { data: result.rows, error: null };
    } catch (err) {
      return { data: null, error: pgErrorShape(err) };
    }
  }

  return {
    pool,
    supabase: {
      from(table: string) {
        return new QueryBuilder(pool, table);
      },
      rpc,
    },
    async close() {
      await pool.end();
    },
  };
}
