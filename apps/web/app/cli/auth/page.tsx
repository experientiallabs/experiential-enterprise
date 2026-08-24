import { CliAuthorize, type AuthorizableOrg } from "@/components/api-keys/CliAuthorize";
import {
  parseLoopbackPort,
  parseState,
  suggestedKeyName
} from "@/lib/api-keys/cli-auth";
import { listAdminOrgs } from "@/lib/auth/admin-orgs";
import { createServerSupabaseClient, requireAuthenticatedUser } from "@/lib/auth/server";

export const metadata = { title: "Authorize the wmo CLI" };

export const dynamic = "force-dynamic";

type CliAuthPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// Approval page `wmo login` opens in the browser. The middleware cookie-gates
// it (an anonymous visit round-trips through /signin?next=…), so by the time
// it renders we have a verified user choosing to hand a key to their CLI.
export default async function CliAuthPage({ searchParams }: CliAuthPageProps) {
  const user = await requireAuthenticatedUser();
  const params = await searchParams;
  const state = parseState(single(params.state));
  const port = parseLoopbackPort(single(params.port));
  const keyName = suggestedKeyName(single(params.name));

  // RLS scopes the read to the member's orgs; only admin orgs can mint.
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("organization_members")
    .select("organizations(id, slug, name)");
  if (error) {
    throw new Error(`Unable to list organizations: ${error.message}`);
  }
  const adminOrgIds = new Set((await listAdminOrgs(user.id)).map((org) => org.id));
  const orgs: AuthorizableOrg[] = [];
  for (const row of data ?? []) {
    // supabase-js types nested selects loosely; normalize object-or-array.
    const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
    if (!org) {
      continue;
    }
    orgs.push({
      id: org.id as string,
      slug: org.slug as string,
      name: org.name as string,
      canManage: adminOrgIds.has(org.id as string)
    });
  }
  orgs.sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="mx-auto flex max-w-[560px] flex-col gap-5 px-6 py-16">
      <div>
        <p className="m-0 mb-2 text-muted-2 text-[11px] font-semibold uppercase">Connect the CLI</p>
        <h1 className="m-0 text-[#171717] text-xl font-semibold">Authorize wmo</h1>
        <p className="mt-2 text-muted text-[13px] leading-relaxed">
          A terminal running <code className="font-mono">wmo login</code> is asking for an API key
          so it can push and pull simulations and harnesses for your organization. The key acts
          at member strength and can be revoked any time from the organization&apos;s API keys page.
        </p>
      </div>
      {state === null ? (
        <div className="rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-[13px] text-danger">
          This authorization link is missing its request nonce. Re-run <code>wmo login</code> and
          use the URL it prints.
        </div>
      ) : (
        <CliAuthorize initialKeyName={keyName} port={port} orgs={orgs} state={state} />
      )}
    </div>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
