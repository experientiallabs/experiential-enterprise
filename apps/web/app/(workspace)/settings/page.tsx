import { redirect } from "next/navigation";

import { connectionsSettingsPath } from "@/lib/routes";

export const dynamic = "force-dynamic";

/** The bare settings URL lands on the first section (Connections — final IA: providers and observability merged there; API keys, aliases, and credits all live top-level). */
export default function SettingsIndexPage() {
  redirect(connectionsSettingsPath());
}
