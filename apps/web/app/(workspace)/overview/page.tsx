import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { VerifyEmailBanner } from "@/components/auth/VerifyEmailBanner";
import { OverviewView } from "@/components/overview/OverviewView";
import { RequestAccessBanner } from "@/components/overview/RequestAccessBanner";
import { YC_INTENT_COOKIE } from "@/components/yc/yc-intent";
import { resolveActiveOrg } from "@/lib/active-org";
import { isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireAuthorizedOrgIds } from "@/lib/auth/orgs";
import { getAuthenticatedUser } from "@/lib/auth/server";
import { isOrgSpendUnlocked } from "@/lib/auth/spend-unlock";
import { getDataSource } from "@/lib/data-source";
import { catalogModelSlugs } from "@/lib/model-links";
import { ycSigninPath } from "@/lib/routes";

export const metadata = { title: "Overview" };

export const dynamic = "force-dynamic";

/**
 * The signed-in landing: your usage, credits, and keys at a glance. Org
 * admins land on the workspace scope with a Personal | Workspace switcher;
 * members land on (and only see) the personal scope.
 *
 * The one authenticated-only page in the product: a signed-out request gets a
 * server redirect to the public door at "/" — no login-modal theater, since
 * the sidebar hides this entry from signed-out visitors anyway.
 */
export default async function OverviewPage() {
  const user = await getAuthenticatedUser();
  if (user === null) {
    redirect("/");
  }
  await redirectUnservedYcIntent();
  const org = await resolveActiveOrg();
  // The workspace-scope gate — "if it's an admin it should show the org view
  // of the overall workspace" (the product owner): org admins plus the platform-admin
  // bypass, the same actors the admin surfaces recognize.
  const isAdmin = (await isPlatformAdmin()) || (await isOrgAdmin(user.id, org.id));
  const spendUnlocked = await isOrgSpendUnlocked(org.id);
  const joinOffer = await loadJoinOffer();
  // Gates which top-model rows link out to /models/{slug}; a warm shared
  // cache read (never a per-visit backend round trip).
  const modelSlugs = await catalogModelSlugs();
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Spend-locked orgs are logged in with credits shown but LOCKED; make the
          one required action (verify email to unlock spend) obvious, not just a
          spend-time error. Spend-unlock is decoupled from login. */}
      {!spendUnlocked && <VerifyEmailBanner email={user.email} />}
      {/* No page title (the product owner, round-2): the header is just the signed-in
          identity, email and active org. */}
      <p className="m-0 text-[13px] leading-relaxed text-muted">
        {user.email === null ? org.name : `${user.email} · ${org.name}`}
      </p>
      {joinOffer !== null ? <RequestAccessBanner offer={joinOffer} /> : null}
      <OverviewView
        canSeeWorkspace={isAdmin}
        knownModelSlugs={modelSlugs}
        org={{ id: org.id, name: org.name }}
      />
    </div>
  );
}

/**
 * The signed-in user's domain-match join offer, shown only when they are not
 * already a member of the matched org. Fails open to no banner: a read hiccup
 * must never block the signed-in home.
 */
async function loadJoinOffer() {
  try {
    const { offer } = await getDataSource().getJoinOffer();
    return offer !== null && !offer.already_member ? offer : null;
  } catch {
    return null;
  }
}

/**
 * Belt-and-suspenders for the /yc funnel: someone who arrived through
 * /signin?yc=1 (the intent cookie) but got bounced here by a generic
 * post-auth redirect has NOT been served the claim — send them to the YC
 * surface, whose signed-in render auto-claims idempotently. An org already
 * on the grant (yc block present) is left alone; every read failure fails
 * open to rendering the Overview, never blocking the signed-in home.
 */
async function redirectUnservedYcIntent(): Promise<void> {
  const cookieStore = await cookies();
  if (cookieStore.get(YC_INTENT_COOKIE)?.value !== "1") {
    return;
  }
  let unclaimed = false;
  try {
    const authorizedOrgIds = await requireAuthorizedOrgIds();
    if (authorizedOrgIds.size === 0) {
      return;
    }
    const org = await resolveActiveOrg();
    unclaimed = (await getDataSource().getOrgBudget(org.id)).yc === null;
  } catch {
    return;
  }
  if (unclaimed) {
    redirect(ycSigninPath());
  }
}
