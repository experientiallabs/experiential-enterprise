type SupabaseAuthSettings = {
  anonKey: string;
  url: string;
};

export function loadSupabaseAuthSettings(): SupabaseAuthSettings {
  const url =
    process.env.SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    process.env.API_URL;
  const anonKey =
    process.env.SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.ANON_KEY;
  if (!url) {
    throw new Error("SUPABASE_URL must be set for Experiential auth.");
  }
  if (!anonKey) {
    throw new Error("SUPABASE_ANON_KEY must be set for Experiential auth.");
  }
  return { anonKey, url };
}
