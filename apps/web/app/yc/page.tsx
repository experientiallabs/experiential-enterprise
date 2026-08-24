import { redirect } from "next/navigation";

import { ycSigninPath } from "@/lib/routes";

export const dynamic = "force-dynamic";

/**
 * The shareable YC short link. The deal itself lives on the sign-in page
 * (the product owner, 2026-08-19: no /yc page — "it should just be sign in with a yc
 * query param"); this route only keeps the short URL that travels by
 * DM/Bookface working.
 */
export default function YcPage(): never {
  redirect(ycSigninPath());
}
