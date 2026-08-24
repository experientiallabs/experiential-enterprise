import { cache } from "react";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

import { authenticatedUserFromClaims, type AuthenticatedUser } from "./claims";
import { loadSupabaseAuthSettings } from "./config";
import { hasSupabaseAuthCookie } from "./cookies";

export type { AuthenticatedUser } from "./claims";

export class AuthRequiredError extends Error {
  constructor(message = "Authentication required.") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

type CookieStore = Awaited<ReturnType<typeof cookies>>;

export async function createServerSupabaseClient(cookieStore?: CookieStore) {
  const resolvedCookieStore = cookieStore ?? (await cookies());
  const settings = loadSupabaseAuthSettings();
  return createServerClient(settings.url, settings.anonKey, {
    cookies: {
      getAll() {
        return resolvedCookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            resolvedCookieStore.set(name, value, options);
          });
        } catch {
          // Server Components cannot set cookies; proxy.ts handles refresh writes.
        }
      }
    }
  });
}

// A route that hands createRouteSupabaseClient one response object but returns
// a different one must carry the auth cookies over, or a session refresh that
// happened during the operation is silently dropped.
export function carryAuthCookies(from: NextResponse, to: NextResponse): NextResponse {
  from.cookies.getAll().forEach((cookie) => to.cookies.set(cookie));
  return to;
}

export function createRouteSupabaseClient(request: NextRequest, response: NextResponse) {
  const settings = loadSupabaseAuthSettings();
  return createServerClient(settings.url, settings.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
        Object.entries(headers).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
      }
    }
  });
}

// Request-scoped: the layout gate and the streaming sidebar both call
// `requireAuthenticatedUser`, so one verification serves the render.
export const getAuthenticatedUser = cache(async (): Promise<AuthenticatedUser | null> => {
  const cookieStore = await cookies();
  if (!hasSupabaseAuthCookie(cookieStore.getAll())) {
    return null;
  }
  const supabase = await createServerSupabaseClient(cookieStore);
  // getClaims verifies the access token locally against the project's JWKS when
  // the signing key is asymmetric (production), cached in-process for 10 minutes
  // by supabase-js — no GoTrue round-trip per render. With an HS256 secret
  // (local stack, previews) it falls back to the GoTrue user lookup internally.
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) {
    return null;
  }
  return authenticatedUserFromClaims(data.claims);
});

export async function requireAuthenticatedUser(): Promise<AuthenticatedUser> {
  const user = await getAuthenticatedUser();
  if (user === null) {
    throw new AuthRequiredError();
  }
  return user;
}
