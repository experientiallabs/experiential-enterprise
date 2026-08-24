type CookieLike = {
  name: string;
};

export function hasSupabaseAuthCookie(cookies: readonly CookieLike[]): boolean {
  return cookies.some(({ name }) => {
    return (
      /^sb-.+-auth-token(?:\.\d+)?$/.test(name) ||
      /^supabase-auth-token(?:\.\d+)?$/.test(name)
    );
  });
}
