import { PlaygroundChat } from "@/components/playground/PlaygroundChat";
import { resolveActiveOrg } from "@/lib/active-org";
import { fetchModelList } from "@/lib/models-catalog/server";
import type { CatalogEntry } from "@/lib/models-catalog/types";

export const metadata = { title: "Playground" };

export const dynamic = "force-dynamic";

type PlaygroundPageProps = {
  // Next delivers a repeated query param (?models=a&models=b) as an array;
  // typing it string-only would crash the .split below on such a URL.
  searchParams: Promise<{ model?: string; models?: string | string[] }>;
};

/**
 * A catalog entry the playground can talk to: a routable chat model. Disabled
 * rows, and rows with no provider route, cannot serve a completion; text-output
 * is the chat contract. This also drops the dead Project-era category artifacts,
 * which carry no gateway deployment.
 */
function isPlayable(entry: CatalogEntry): boolean {
  return (
    entry.model.status !== "disabled" &&
    entry.providers.length > 0 &&
    entry.model.output_modalities.includes("text")
  );
}

export default async function PlaygroundPage({ searchParams }: PlaygroundPageProps) {
  // ?models=a,b,c (the compare deep link) wins over the historic ?model=; the
  // component validates, dedupes, and caps the list.
  const { model, models: multi } = await searchParams;
  const joined = Array.isArray(multi) ? multi.join(",") : multi;
  const requested = (joined ?? model ?? "")
    .split(",")
    .map((slug) => slug.trim())
    .filter((slug) => slug !== "");
  const [org, catalog] = await Promise.all([resolveActiveOrg(), fetchModelList()]);
  const models = catalog.models.filter(isPlayable);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PlaygroundChat initialModelSlugs={requested} models={models} orgId={org.id} />
    </div>
  );
}
