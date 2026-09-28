/**
 * Keeps each organization's voice catalog to what should actually be
 * offered for calls, per explicit request: "only keep English Cartesia
 * voices, remove everything else", and show "Ray", not "Ray -
 * Conversationalist".
 *
 * - Voices that are not English Cartesia voices are set inactive (hidden
 *   from every voice list/picker). Kept anyway: cloned voices (the
 *   organization's own) and any voice a campaign's current version or a
 *   published agent version still uses - hiding those would block
 *   starting/resuming that campaign (campaignPreflight requires an active
 *   voice). Once nothing uses them, the next run hides them too.
 * - Cartesia's emotion variants of the same voice ("Carson - Angry
 *   Friendly Support" next to "Carson - Friendly Support") are hidden.
 * - Display name = the person's name only (spokenVoiceName of the
 *   provider label, kept in voices.provider_name); where two kept voices
 *   share a name, later ones get " 2", " 3" so they stay tellable apart.
 *
 * Never reactivates anything and never deletes rows (calls and agent/
 * campaign versions keep pointing at the same voices). Idempotent: only
 * rows whose status/name actually change are written.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { spokenVoiceName } from '../lib/promptVariables.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

interface VoiceRow {
  id: string;
  organization_id: string;
  provider_key: string;
  language: string | null;
  name: string;
  provider_name: string | null;
  status: string;
  is_cloned: boolean | null;
  created_at: string;
}

const EMOTIONS = ['angry', 'sad', 'scared', 'disgusted', 'surprised', 'yelling', 'curious', 'happy'];
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

function splitLabel(label: string): { person: string; rest: string } {
  const match = label.split(/\s+[-–—]\s*|\s*[-–—]\s+/);
  return { person: (match[0] ?? '').trim().toLowerCase(), rest: match.slice(1).join(' - ').trim().toLowerCase() };
}

function isEnglishCartesia(v: VoiceRow): boolean {
  return v.provider_key === 'cartesia' && (v.language ?? '').toLowerCase().startsWith('en');
}

/** Pure planning step (unit-tested): which voices to hide and rename. */
export function planVoiceCatalog(voices: VoiceRow[], inUse: Set<string>): { deactivate: string[]; rename: Array<{ id: string; name: string }> } {
  const labelOf = (v: VoiceRow) => (v.provider_name ?? v.name).trim();
  const labels = new Set(voices.map((v) => {
    const { person, rest } = splitLabel(labelOf(v));
    return `${v.organization_id}|${person}|${rest}`;
  }));

  const deactivate: string[] = [];
  const kept: VoiceRow[] = [];
  for (const v of voices) {
    if (v.status !== 'active') continue;
    const protectedVoice = inUse.has(v.id) || Boolean(v.is_cloned);
    let hide = !protectedVoice && !isEnglishCartesia(v);
    if (!hide && !protectedVoice && v.provider_key === 'cartesia') {
      const { person, rest } = splitLabel(labelOf(v));
      const [first, ...others] = rest.split(/\s+/);
      if (EMOTIONS.includes(first) && labels.has(`${v.organization_id}|${person}|${others.join(' ')}`)) hide = true;
    }
    if (hide) deactivate.push(v.id);
    else kept.push(v);
  }

  const rename: Array<{ id: string; name: string }> = [];
  const seen = new Map<string, number>();
  for (const v of [...kept].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    if (v.provider_key !== 'cartesia' || v.is_cloned) continue;
    const base = spokenVoiceName(labelOf(v)) ?? labelOf(v);
    const key = `${v.organization_id}|${base.toLowerCase()}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const name = n === 1 ? base : `${base} ${n}`;
    if (name !== v.name) rename.push({ id: v.id, name });
  }
  return { deactivate, rename };
}

async function voicesInUse(supabase: Supabase, orgId: string | null): Promise<Set<string>> {
  const inUse = new Set<string>();
  let campaigns = supabase.from('campaigns').select('current_version_id');
  if (orgId) campaigns = campaigns.eq('organization_id', orgId);
  const { data: campaignRows } = await campaigns;
  const versionIds = (campaignRows ?? [])
    .map((c: { current_version_id: string | null }) => c.current_version_id)
    .filter((id): id is string => Boolean(id));
  for (let i = 0; i < versionIds.length; i += 200) {
    const { data } = await supabase.from('campaign_versions').select('voice_id').in('id', versionIds.slice(i, i + 200));
    for (const r of data ?? []) if (r.voice_id) inUse.add(r.voice_id as string);
  }
  let agents = supabase.from('ai_agent_versions').select('voice_id').eq('status', 'published');
  if (orgId) agents = agents.eq('organization_id', orgId);
  const { data: agentRows } = await agents;
  for (const r of agentRows ?? []) if (r.voice_id) inUse.add(r.voice_id as string);
  return inUse;
}

export async function normalizeVoiceCatalog(orgId: string | null = null): Promise<{ deactivated: number; renamed: number }> {
  const supabase = getSupabaseAdmin();
  const voices: VoiceRow[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase
      .from('voices')
      .select('id, organization_id, provider_key, language, name, provider_name, status, is_cloned, created_at')
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (orgId) q = q.eq('organization_id', orgId);
    const { data, error } = await q;
    if (error) throw error;
    voices.push(...((data ?? []) as VoiceRow[]));
    if (!data || data.length < 1000) break;
  }

  const { deactivate, rename } = planVoiceCatalog(voices, await voicesInUse(supabase, orgId));
  for (let i = 0; i < deactivate.length; i += 200) {
    const { error } = await supabase.from('voices').update({ status: 'inactive' }).in('id', deactivate.slice(i, i + 200));
    if (error) throw error;
  }
  for (const r of rename) {
    const { error } = await supabase.from('voices').update({ name: r.name }).eq('id', r.id);
    if (error) throw error;
  }
  return { deactivated: deactivate.length, renamed: rename.length };
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startVoiceCatalogSync(): void {
  if (intervalHandle) return;
  const run = () =>
    normalizeVoiceCatalog()
      .then((r) => {
        // eslint-disable-next-line no-console
        if (r.deactivated || r.renamed) console.log('voiceCatalog: normalized', r);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('voiceCatalog: normalize failed', err);
      });
  void run();
  intervalHandle = setInterval(run, SYNC_INTERVAL_MS);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
}
