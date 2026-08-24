import { configuredServingBaseUrl } from "@/components/world-models/endpoint-snippets";
import { jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

// Public discovery endpoint for `wmo login`: which backend host the CLI
// should call. The URL is not a secret — every world model's Endpoints page
// shows it to members — and everything behind it is bearer-gated; publishing
// it here just saves users from configuring two URLs by hand.
//
// One resolver for the whole product (endpoint-snippets.tsx): a deployment
// that is not the hosted platform sets EXPLABS_PUBLIC_BACKEND_URL. Null keeps
// its meaning for the CLI ("this web app advertises no override, use your
// default"), so a misconfigured self-host cannot silently point CLIs at the
// hosted platform.
export async function GET(): Promise<Response> {
  return jsonOk({ apiUrl: configuredServingBaseUrl() });
}
