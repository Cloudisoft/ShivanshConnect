/**
 * Phase 15 load test: mocks ONLY the outbound network boundary to Vapi's
 * real REST API (see lib/orchestration/vapi.ts's `VAPI_API_BASE =
 * 'https://api.vapi.ai'`) - never a real phone call is placed, per spec
 * section 75's explicit requirement. Every other layer (assistant/phone-
 * number-import/call-creation request SHAPING, credential decryption, the
 * `calls` row lifecycle) is the real production code in
 * services/callOrigination.ts and lib/orchestration/vapi.ts, unmodified.
 *
 * Mirrors the exact endpoint shapes campaigns.integration.test.ts's own
 * fetch mock already establishes for Phase 7's tests - this is the same
 * contract at load-test scale, not a different one.
 */
import { vi } from 'vitest';

export interface VapiFetchCounters {
  assistantsCreated: number;
  phoneNumbersImported: number;
  callsCreated: number;
}

export function installMockVapiFetch(): VapiFetchCounters {
  const counters: VapiFetchCounters = { assistantsCreated: 0, phoneNumbersImported: 0, callsCreated: 0 };

  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url === 'https://api.vapi.ai/assistant' && method === 'POST') {
      counters.assistantsCreated += 1;
      return { ok: true, status: 200, json: async () => ({ id: `asst_${counters.assistantsCreated}` }) } as unknown as Response;
    }
    if (url === 'https://api.vapi.ai/phone-number' && method === 'POST') {
      counters.phoneNumbersImported += 1;
      return { ok: true, status: 200, json: async () => ({ id: `vapi_pn_${counters.phoneNumbersImported}` }) } as unknown as Response;
    }
    if (url === 'https://api.vapi.ai/call' && method === 'POST') {
      counters.callsCreated += 1;
      return { ok: true, status: 200, json: async () => ({ id: `vapi_call_${counters.callsCreated}`, status: 'queued' }) } as unknown as Response;
    }
    if (url.startsWith('https://api.vapi.ai/assistant?') && method === 'GET') {
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }
    // Anything else (e.g. processCallArtifacts' fire-and-forget recording/
    // transcript fetch against a call's provider URL, or a getCall() probe
    // from the reconciliation job) is deliberately left unmocked here -
    // each caller already handles a failed fetch by marking that specific
    // artifact/record failed rather than throwing, so this never corrupts
    // the invariants this load test actually checks. See
    // processCallArtifacts.ts's own try/catch.
    throw new Error(`Unmocked fetch in load test: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return counters;
}
