import { NextResponse, type NextRequest } from "next/server";

import { createRouteSupabaseClient } from "@/lib/auth/server";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  const supabase = createRouteSupabaseClient(request, response);
  await supabase.auth.signOut();
  return response;
}
