import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

/**
 * Phase 2 integration test: create a lead list -> upload a CSV import
 * (2 valid rows, 1 in-file duplicate, 1 invalid phone, 1 DNC number) ->
 * commit -> verify the final lead count and import job summary match
 * expectations, plus tenant isolation (org B cannot see org A's leads or
 * lists). Same "mock Supabase at the DB-client boundary" approach as
 * integration.test.ts (see that file's header for why).
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.FRONTEND_URL = 'http://localhost:5173';

const fake = createFakeSupabase();

vi.mock('./lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
  getSupabaseAnon: () => fake.supabase,
}));

function buildMultipartCsv(fileName: string, csv: string): { body: Buffer; contentType: string } {
  const boundary = '----phase2TestBoundary';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: text/csv\r\n\r\n` +
    `${csv}\r\n` +
    `--${boundary}--\r\n`;
  return { body: Buffer.from(body), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function waitForJobStatus(
  app: Awaited<ReturnType<typeof import('./index.js').buildApp>>,
  token: string,
  jobId: string,
  targetStatuses: string[],
  maxAttempts = 50,
): Promise<any> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/import-jobs/${jobId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json();
    if (targetStatuses.includes(body.data.status)) return body.data;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Import job ${jobId} did not reach status ${targetStatuses.join('/')} in time`);
}

describe('Phase 2: lead list -> CSV import -> commit', () => {
  let app: Awaited<ReturnType<typeof import('./index.js').buildApp>>;

  beforeAll(async () => {
    const { buildApp } = await import('./index.js');
    app = buildApp();
    await app.ready();
  });

  it('imports valid rows, skips duplicate/invalid/DNC rows, and reports an accurate summary', async () => {
    // 1. Signup org A.
    const signupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        organization_name: 'Import Test Org',
        full_name: 'Ivy Importer',
        email: 'ivy@importtest.com',
        password: 'supersecret123',
      },
    });
    expect(signupRes.statusCode).toBe(201);
    const token = signupRes.json().data.session.access_token;

    // 2. Create a lead list.
    const listRes = await app.inject({
      method: 'POST',
      url: '/api/v1/lead-lists',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Spring Campaign' },
    });
    expect(listRes.statusCode).toBe(201);
    const listId = listRes.json().data.id;

    // 3. Put one number on the DNC list ahead of the import.
    const dncRes = await app.inject({
      method: 'POST',
      url: '/api/v1/dnc',
      headers: { authorization: `Bearer ${token}` },
      payload: { phone: '484-555-9999', reason: 'Caller requested' },
    });
    expect(dncRes.statusCode).toBe(201);

    // 4. Upload a CSV: 2 valid, 1 in-file duplicate, 1 invalid, 1 DNC.
    const csv = [
      'first_name,last_name,phone',
      'John,Smith,484-555-1234',
      'Jane,Doe,(484) 555-5678',
      'John,Smith,484-555-1234',
      'Bad,Row,12345',
      'Dnc,Person,484-555-9999',
    ].join('\n');
    const { body, contentType } = buildMultipartCsv('leads.csv', csv);

    const importRes = await app.inject({
      method: 'POST',
      url: `/api/v1/lead-lists/${listId}/import`,
      headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
      payload: body,
    });
    expect(importRes.statusCode).toBe(202);
    const jobId = importRes.json().data.id;

    // 5. Poll until validation finishes.
    const readyJob = await waitForJobStatus(app, token, jobId, ['ready_for_review', 'failed']);
    expect(readyJob.status).toBe('ready_for_review');
    expect(readyJob.total_rows).toBe(5);
    expect(readyJob.valid_rows).toBe(2);
    expect(readyJob.duplicate_rows).toBe(1);
    expect(readyJob.invalid_rows).toBe(1);
    expect(readyJob.dnc_rows).toBe(1);

    // 6. Commit the import.
    const commitRes = await app.inject({
      method: 'POST',
      url: `/api/v1/import-jobs/${jobId}/commit`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(commitRes.statusCode).toBe(200);
    const committed = commitRes.json().data;
    expect(committed.status).toBe('completed');
    expect(committed.imported_rows).toBe(2);

    // 7. The lead list now has exactly 2 leads.
    const leadsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/leads?lead_list_id=${listId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(leadsRes.statusCode).toBe(200);
    const leadsBody = leadsRes.json();
    expect(leadsBody.data).toHaveLength(2);
    expect(leadsBody.pagination.total).toBe(2);
    const phones = leadsBody.data.map((l: any) => l.phone_normalized).sort();
    expect(phones).toEqual(['+14845551234', '+14845555678']);

    // 8. Error report CSV lists exactly the 3 non-valid rows.
    const errorsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/import-jobs/${jobId}/errors`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(errorsRes.statusCode).toBe(200);
    const errorLines = errorsRes.body.trim().split('\n');
    expect(errorLines).toHaveLength(4); // header + 3 error rows

    // 9. Re-importing a duplicate single lead is rejected.
    const dupLeadRes = await app.inject({
      method: 'POST',
      url: '/api/v1/leads',
      headers: { authorization: `Bearer ${token}` },
      payload: { first_name: 'John', last_name: 'Smith', phone: '4845551234' },
    });
    expect(dupLeadRes.statusCode).toBe(422);

    // 10. Tenant isolation: org B cannot see org A's list or leads.
    const otherSignup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        organization_name: 'Other Import Org',
        full_name: 'Oscar Outsider',
        email: 'oscar@otherimport.com',
        password: 'supersecret123',
      },
    });
    const otherToken = otherSignup.json().data.session.access_token;

    const crossListRes = await app.inject({
      method: 'GET',
      url: `/api/v1/lead-lists/${listId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(crossListRes.statusCode).toBe(404);

    const crossLeadsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/leads?lead_list_id=${listId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(crossLeadsRes.statusCode).toBe(200);
    expect(crossLeadsRes.json().data).toHaveLength(0);

    const crossJobRes = await app.inject({
      method: 'GET',
      url: `/api/v1/import-jobs/${jobId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(crossJobRes.statusCode).toBe(404);
  });
});
