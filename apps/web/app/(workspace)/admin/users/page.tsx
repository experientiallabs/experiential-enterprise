import { UsersBrowse } from "@/components/admin/UsersBrowse";
import { listAdministeredUsers } from "@/lib/admin/users-server";
import { requireAuthenticatedUser } from "@/lib/auth/server";

export const metadata = { title: "Admin · Users" };

export const dynamic = "force-dynamic";

/**
 * The Users section: every auth account with the shared per-user account
 * actions (email edit, ban/unban, experiential-admin grant/revoke, account
 * deletion). The eyebrow and section tabs come from the admin layout above,
 * which also carries the platform-admin gate; the browse component owns
 * search, filter, and the action flows. This panel spans every account;
 * customers never see it.
 */
export default async function AdminUsersPage() {
  const [users, viewer] = await Promise.all([listAdministeredUsers(), requireAuthenticatedUser()]);
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="m-0 text-xl font-semibold text-ink">Users</h1>
        <p className="mt-2 max-w-[780px] text-sm leading-relaxed text-muted">
          Every account on the platform: edit the account email, ban or unban, grant or
          revoke experiential-admin status, or delete the account. Banning blocks all
          sign-in methods, ends the user&apos;s sessions, and revokes the API keys they
          created; unbanning restores sign-in only. Per-org membership management
          (roles, removal, invites) lives on each organization&apos;s page, linked from the
          Organizations column.
        </p>
      </div>
      <UsersBrowse users={users} currentUserId={viewer.id} />
    </div>
  );
}
