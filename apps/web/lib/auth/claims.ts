// The app's authenticated-user shape, derived from verified JWT claims. Only the
// fields the UI actually consumes are carried; everything else stays in the token.
export type AuthenticatedUser = {
  id: string;
  email: string | null;
};

type VerifiedClaims = {
  sub?: string;
  email?: unknown;
};

// Map verified access-token claims to the app's user shape. `sub` carries the
// Supabase user id on every access token; `email` is optional on the token, so
// non-string values collapse to null rather than leaking through.
export function authenticatedUserFromClaims(claims: VerifiedClaims): AuthenticatedUser | null {
  if (!claims.sub) {
    return null;
  }
  return {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null
  };
}
