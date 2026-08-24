import { CreditGatingPanel } from "@/components/admin/CreditGatingPanel";

export const metadata = { title: "Admin platform settings" };

export const dynamic = "force-dynamic";

/**
 * The Platform section: platform-wide settings that span every organization.
 * The admin layout above gates the whole segment to platform operators (a
 * non-admin gets not-found), so this page renders only after that check. The
 * credit-gating panel reads and writes app_settings through the gated admin API.
 */
export default function AdminPlatformPage() {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="m-0 text-xl font-semibold text-ink">Credits &amp; verification</h1>
        <p className="mt-2 max-w-[780px] text-sm leading-relaxed text-muted">
          The grant amounts new users receive, how much they can spend before verifying, and what
          unlocks spending. Applies across every organization; customers never see this.
        </p>
      </div>
      <CreditGatingPanel />
    </div>
  );
}
