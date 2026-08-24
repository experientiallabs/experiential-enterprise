import { NextResponse, type NextRequest } from "next/server";

import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { provisionInstantAccount } from "@/lib/auth/instant-signup";
import { requestOrigin, safePrefillEmail } from "@/lib/auth/redirects";
import { carryAuthCookies, createRouteSupabaseClient } from "@/lib/auth/server";
import { sendSigninCode, sendVerificationEmail } from "@/lib/auth/verification";
import { slugify } from "@/lib/format";

export const dynamic = "force-dynamic";

// Creates an organization WITH its founding admin. Platform-admin surface;
// non-admins see the standard not-found.
//
// RLS note: the writes here ride the SERVICE ROLE (provisioning and membership
// binding need it), so isPlatformAdmin() is the only guard in front of them.
// That gate must stay first and unconditional.
//
// Every admin-created org is bound to a founder email and sits behind the SAME
// spend gate as self-serve signups: organizations.spend_unlocked_at stays NULL
// (this route never writes it), so the $20 welcome grant the org-insert
// trigger applies is LOCKED until the founder proves inbox ownership (emailed
// link or code), which unlocks every org they founded via
// public.unlock_founder_spend. The founder is the org's earliest (only)
// role='admin' member, so that definer function targets exactly this org.
//
// Two founder paths, mirroring the signup contract (AGENTS.md):
// * NEW email: the instant-account machinery (admin.createUser with
//   email_confirm: true, which grants LOGIN permission only, never inbox
//   proof) creates the account, and the auth.users provisioning trigger
//   creates their org, grant, and identities; this route then renames that
//   org to the entered name and sends the verification email best-effort.
// * EXISTING email: NEVER auto-logged-in and NEVER auto-verified. The account
//   must not be banned, the org is created directly (the organizations-insert
//   triggers still apply the grant and seed the default identity), the user
//   becomes its founding admin, and an emailed sign-in code gives them a real
//   inbox-proof route to unlock the org.
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const response = NextResponse.json({ ok: true });
  const session = createRouteSupabaseClient(request, response);
  const send = (body: unknown, status: number) =>
    carryAuthCookies(response, NextResponse.json(body, { status }));

  // Parse failures are the caller's 400; everything past here that throws is a
  // server fault and must not leak internals (a missing service-role key names
  // an env var in its message).
  let payload: { name: string; founderEmail: string };
  try {
    payload = parseCreateOrgPayload(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid organization request.";
    return send({ error: message }, 400);
  }

  try {
    const admin = createServiceRoleSupabaseClient();
    const origin = requestOrigin(request);

    const provisioned = await provisionInstantAccount(admin, payload.founderEmail, null, null);
    if (provisioned.status === "signup_failed") {
      return send({ error: provisioned.message }, 500);
    }

    if (provisioned.status === "created") {
      // A fresh account: the provisioning trigger already created the founder's
      // org (grant applied and spend-locked); it just carries the email-derived
      // name. Rename it to the admin's chosen name and slug.
      const { data, error } = await admin
        .from("organizations")
        .update({ name: payload.name, slug: orgSlugFor(payload.name) })
        .eq("id", provisioned.orgId)
        .select("id, name, slug")
        .single();
      if (error) {
        // Compensate, or an admin retry would land in the existing-email
        // branch and mint a SECOND org with another welcome grant.
        const cleaned = await deleteOrgOrWarn(admin, provisioned.orgId);
        return send(
          {
            error: cleaned
              ? "The organization could not be set up; the partial organization was removed. Try again."
              : `The organization could not be set up and cleanup failed; delete organization ${provisioned.orgId} manually before retrying.`
          },
          500
        );
      }
      // Best-effort: the founder needs the link to unlock spend, but the org
      // already exists and works for everything except spending.
      const verification = await sendVerificationEmail(admin, payload.founderEmail, origin);
      return send(
        {
          organization: data,
          founder: { email: payload.founderEmail, status: "created" },
          verification_email_sent: verification.sent
        },
        201
      );
    }

    // account_exists: resolve the user through the admin-gated roster RPC
    // (PostgREST cannot see auth.users). No session is minted and nothing is
    // auto-verified for an existing address.
    const { data: users, error: usersError } = await session.rpc("admin_list_users");
    if (usersError) {
      return send({ error: usersError.message }, 500);
    }
    const founder = (
      (users ?? []) as Array<{ id: string; email: string | null; banned_until: string | null }>
    ).find((user) => user.email?.toLowerCase() === payload.founderEmail.toLowerCase());
    if (founder === undefined) {
      return send({ error: "The founder account exists but could not be resolved; try again." }, 500);
    }
    // A banned founder can never prove their inbox, so the org could never
    // unlock; refuse instead of creating a permanently locked tenant.
    if (founder.banned_until !== null && new Date(founder.banned_until).getTime() > Date.now()) {
      return send(
        { error: "That founder's account is banned. Unban it first or use a different email." },
        422
      );
    }
    const { data: org, error: orgError } = await admin
      .from("organizations")
      .insert({ name: payload.name, slug: orgSlugFor(payload.name) })
      .select("id, name, slug")
      .single();
    if (orgError) {
      return send({ error: orgError.message }, 500);
    }
    const { error: memberError } = await admin
      .from("organization_members")
      .insert({ org_id: org.id, user_id: founder.id, role: "admin" });
    if (memberError) {
      // A memberless org can never be unlocked; do not leave one behind.
      const cleaned = await deleteOrgOrWarn(admin, org.id);
      return send(
        {
          error: cleaned
            ? memberError.message
            : `${memberError.message} (cleanup also failed; delete organization ${org.id} manually)`
        },
        500
      );
    }
    // The founder must have a real inbox-proof route to unlock the org: an
    // emailed sign-in code (never an auto-login). Without it, a password or
    // OAuth user might never trip unlock_founder_spend and the org would stay
    // locked until the rotation trigger eventually fires against legitimate
    // later members.
    const signinSent = await sendSigninCode(payload.founderEmail, origin);
    return send(
      {
        organization: org,
        founder: { email: payload.founderEmail, status: "existing" },
        verification_email_sent: signinSent
      },
      201
    );
  } catch (error) {
    console.error("admin org create failed:", error);
    return send({ error: "Organization creation failed." }, 500);
  }
}

/**
 * Best-effort compensating delete for a just-created org. Returns whether the
 * delete succeeded; a failure is logged and the caller must say so out loud
 * rather than leaving a memberless locked org behind silently.
 */
async function deleteOrgOrWarn(
  admin: ReturnType<typeof createServiceRoleSupabaseClient>,
  orgId: string
): Promise<boolean> {
  const { error } = await admin.from("organizations").delete().eq("id", orgId);
  if (error) {
    console.error(`admin org create: cleanup of organization ${orgId} failed: ${error.message}`);
    return false;
  }
  return true;
}

// Mirror the signup trigger's slug shape: sanitized name plus a random suffix
// so renames and same-named tenants never collide.
function orgSlugFor(name: string): string {
  const slugBase = slugify(name) || "org";
  return `${slugBase}-${crypto.randomUUID().slice(0, 8)}`;
}

function parseCreateOrgPayload(value: unknown): { name: string; founderEmail: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Organization request must be an object.");
  }
  const payload = value as Record<string, unknown>;
  if (typeof payload.name !== "string" || payload.name.trim().length === 0) {
    throw new Error("Organization request must include a name.");
  }
  if (typeof payload.founder_email !== "string" || payload.founder_email.trim().length === 0) {
    throw new Error("Organization request must include the founder's email.");
  }
  const founderEmail = safePrefillEmail(payload.founder_email);
  if (founderEmail === null) {
    throw new Error("The founder email is not a valid address.");
  }
  return { name: payload.name.trim(), founderEmail };
}
