import { notFound } from "next/navigation";

import { SuperadminKeysPanel } from "@/components/admin/SuperadminKeysPanel";
import { listSuperadminKeys } from "@/lib/admin/superadmin-keys";
import { requirePlatformAdmin } from "@/lib/auth/admin";
import { DataSourceNotFoundError } from "@/lib/errors";

export const metadata = { title: "Admin · Access" };

export const dynamic = "force-dynamic";

/**
 * The Access section: superadmin machine keys — the `xpladmin_` bearers the
 * control API accepts as platform-admin actors. The eyebrow and section tabs
 * come from the admin layout above, which also carries the platform-admin
 * gate. This panel lists and revokes; MINTING happens only when an operator
 * is granted superadmin status (the site-admin grant route on the Users
 * surfaces), where the secret is shown once. The API layer only
 * authenticates keys and can never create one.
 */
export default async function AdminAccessPage() {
  // The admin layout gates too, but layouts are not a security boundary and
  // listSuperadminKeys reads over the service role (no RLS backstop), so the
  // page re-asserts the gate itself. isPlatformAdmin is request-cached, so
  // this costs nothing beyond the layout's own check.
  try {
    await requirePlatformAdmin();
  } catch (error) {
    if (error instanceof DataSourceNotFoundError) {
      notFound();
    }
    throw error;
  }
  const keys = await listSuperadminKeys();
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="m-0 text-xl font-semibold text-ink">Superadmin keys</h1>
        <p className="mt-2 max-w-[780px] text-sm leading-relaxed text-muted">
          Superadmin keys authenticate machine callers as their owner with full platform-admin
          authority against api.experientiallabs.ai. A key is created when an operator is
          granted superadmin status and its secret is shown once at that grant; only its hash
          is stored, and this page lists and revokes. Revoke on any doubt; a key also dies
          instantly if its owner leaves platform_admins. Keys are never minted through the API.
        </p>
      </div>
      <SuperadminKeysPanel keys={keys} />
    </div>
  );
}
