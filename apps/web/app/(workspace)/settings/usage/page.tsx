import { redirect } from "next/navigation";

import { creditsPath } from "@/lib/routes";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{ topup?: string }>;
};

/**
 * Billing left settings: /settings/usage is the old home of the credits page
 * and now redirects to top-level /credits. Stripe Checkout sessions minted
 * before the move return here with a result flag, so that one query param
 * rides along; everything else drops.
 */
export default async function LegacySettingsUsagePage({ searchParams }: Props) {
  const { topup } = await searchParams;
  const flag = topup === "success" || topup === "cancelled" ? `?topup=${topup}` : "";
  redirect(`${creditsPath()}${flag}`);
}
