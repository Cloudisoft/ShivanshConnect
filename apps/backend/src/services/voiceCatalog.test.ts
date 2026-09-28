import { describe, expect, it } from 'vitest';
import { planVoiceCatalog } from './voiceCatalog.js';

let seq = 0;
function voice(name: string, over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `v${seq}`,
    organization_id: 'org-1',
    provider_key: 'cartesia',
    language: 'en',
    name,
    provider_name: name,
    status: 'active',
    is_cloned: false,
    created_at: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
    ...over,
  };
}

describe('planVoiceCatalog', () => {
  it('keeps English Cartesia voices with just the person name', () => {
    const ray = voice('Ray - Conversationalist');
    const alexei = voice('Alexei\t- Articulate Analyst');
    const { deactivate, rename } = planVoiceCatalog([ray, alexei], new Set());
    expect(deactivate).toEqual([]);
    expect(rename).toEqual([
      { id: ray.id, name: 'Ray' },
      { id: alexei.id, name: 'Alexei' },
    ]);
  });

  it('hides non-English and non-Cartesia voices unless something still uses them', () => {
    const aarti = voice('Aarti - Conversationalist', { language: 'hi' });
    const claire = voice('claire', { provider_key: 'elevenlabs' });
    const max = voice('max', { provider_key: 'elevenlabs' });
    const cloned = voice('My Voice', { provider_key: 'elevenlabs', is_cloned: true });
    const { deactivate } = planVoiceCatalog([aarti, claire, max, cloned], new Set([claire.id]));
    expect(deactivate.sort()).toEqual([aarti.id, max.id].sort());
  });

  it("hides Cartesia's emotion variants but not voices whose style merely starts with that word", () => {
    const base = voice('Carson - Friendly Support');
    const angry = voice('Carson - Angry Friendly Support');
    const happyOnly = voice('Camila - Happy Conversationalist');
    const { deactivate } = planVoiceCatalog([base, angry, happyOnly], new Set());
    expect(deactivate).toEqual([angry.id]);
  });

  it('numbers kept voices that end up with the same name', () => {
    const a1 = voice('Alice - Attentive Supporter');
    const a2 = voice('Alice - Informative Speaker');
    const { rename } = planVoiceCatalog([a1, a2], new Set());
    expect(rename).toEqual([
      { id: a1.id, name: 'Alice' },
      { id: a2.id, name: 'Alice 2' },
    ]);
  });

  it('is idempotent once names are clean', () => {
    const ray = voice('Ray', { provider_name: 'Ray - Conversationalist' });
    expect(planVoiceCatalog([ray], new Set())).toEqual({ deactivate: [], rename: [] });
  });
});
