import type { NextRequest } from "next/server";

import { buildLlmsTxt } from "@/lib/llms-txt";
import { webBaseUrlFromHeaders } from "@/lib/public-web-url";

// Rendered per request so the URLs always reflect this deployment: the API
// base through the one resolver (endpoint-snippets.tsx), the web app from the
// request's own origin, so a local stack's copy names http://localhost:3300
// rather than the hosted domain.
export const dynamic = "force-dynamic";

// Public by design (the proxy is public-by-default; nothing claims this
// path): the whole point is that an agent can scrape it without a session.
export async function GET(request: NextRequest): Promise<Response> {
  // The origin the CLIENT used, not the container's bind address: honor the
  // proxy's forwarded headers first, then the plain Host. No host at all
  // falls back to the hosted default inside buildLlmsTxt.
  const webBaseUrl = webBaseUrlFromHeaders(request.headers);
  return new Response(buildLlmsTxt({ webBaseUrl }), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600"
    }
  });
}
