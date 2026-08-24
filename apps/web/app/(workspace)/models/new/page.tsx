import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { CustomModelForm } from "@/components/models-catalog/custom-model-form";
import { resolveActiveOrg } from "@/lib/active-org";
import { getAuthenticatedUser } from "@/lib/auth/server";
import { modelsPath } from "@/lib/routes";

export const metadata = { title: "Add a model" };

export const dynamic = "force-dynamic";

/**
 * Bring your own model: served through the same gateway endpoint, telemetry
 * identical, visible only to its organization. The frame renders signed out;
 * the form opens the login modal on arrival and gates submit (design-system
 * gating contract — navigation is never gated, acting is).
 */
export default async function NewModelPage() {
  const user = await getAuthenticatedUser();
  const org = user === null ? null : await resolveActiveOrg();
  return (
    <div className="flex min-h-0 flex-col gap-5">
      <div>
        <Link
          className="mb-3 inline-flex w-fit items-center gap-1.5 text-[12.5px] font-semibold text-muted transition-colors hover:text-ink"
          href={modelsPath()}
        >
          <ArrowLeft aria-hidden size={13} strokeWidth={1.8} />
          Models
        </Link>
        <h1 className="m-0 text-xl font-semibold text-ink">Add a model</h1>
        <p className="mt-2 max-w-[780px] text-[13px] leading-relaxed text-muted">
          Serve your own OpenAI-compatible model through the gateway: same endpoint, same
          telemetry, visible only to your organization.
        </p>
      </div>
      <CustomModelForm orgId={org?.id ?? null} />
    </div>
  );
}
