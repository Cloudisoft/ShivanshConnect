import type { SupabaseClient } from '@supabase/supabase-js';

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'org';
}

/** Generates a URL-safe, unique organization slug from a display name. */
export async function generateUniqueOrgSlug(
  supabase: SupabaseClient,
  name: string,
): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let suffix = 1;

  // Bounded loop: practically only ever iterates once or twice.
  for (let attempts = 0; attempts < 50; attempts += 1) {
    const { data, error } = await supabase
      .from('organizations')
      .select('id')
      .eq('slug', candidate)
      .maybeSingle();

    if (error) throw error;
    if (!data) return candidate;

    suffix += 1;
    candidate = `${base}-${suffix}`;
  }

  return `${base}-${Date.now()}`;
}
