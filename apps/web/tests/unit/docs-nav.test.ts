import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DOCS_NAV, DOCS_PAGES, docsPrevNext } from "@/components/docs/docs-nav";
import {
  docsAnthropicPath,
  docsAuthenticationPath,
  docsBillingPath,
  docsCodingAgentsPath,
  docsCoreLoopPath,
  docsErrorsPath,
  docsInternalPath,
  docsModelsPath,
  docsPath,
  docsQuickstartPath,
  docsReferencePath,
  docsSetupPromptsPath,
  docsTelemetryPath
} from "@/lib/routes";

const APP_DOCS_DIR = join(__dirname, "..", "..", "app", "docs");

function pageFileFor(path: string): string {
  const segments = path.split("/").filter(Boolean).slice(1); // drop "docs"
  return join(APP_DOCS_DIR, ...segments, "page.tsx");
}

describe("docs nav", () => {
  it("lists the launch IA in reading order (D: sidebar IA, gw-docs P1)", () => {
    expect(DOCS_PAGES.map((entry) => entry.path)).toEqual([
      docsPath(),
      docsQuickstartPath(),
      docsSetupPromptsPath(),
      docsCoreLoopPath(),
      docsAuthenticationPath(),
      docsCodingAgentsPath(),
      docsModelsPath(),
      docsAnthropicPath(),
      docsErrorsPath(),
      docsBillingPath(),
      docsTelemetryPath(),
      docsReferencePath()
    ]);
  });

  it("has a registered route file for every listed page", () => {
    for (const entry of DOCS_PAGES) {
      expect(existsSync(pageFileFor(entry.path)), `${entry.path} needs a page.tsx`).toBe(true);
    }
  });

  it("registers the admin-only internal route without listing it anywhere", () => {
    // The route must exist for docs-P7's gate, and must never surface in the
    // public nav or the search index (which derives from DOCS_PAGES).
    expect(existsSync(pageFileFor(docsInternalPath()))).toBe(true);
    expect(DOCS_PAGES.some((entry) => entry.path === docsInternalPath())).toBe(false);
    expect(
      DOCS_NAV.some((group) => group.entries.some((entry) => entry.path === docsInternalPath()))
    ).toBe(false);
  });

  it("walks prev/next along the sidebar order and goes quiet off the tree", () => {
    expect(docsPrevNext(docsPath())).toEqual({
      prev: null,
      next: expect.objectContaining({ path: docsQuickstartPath() })
    });
    expect(docsPrevNext(docsSetupPromptsPath())).toEqual({
      prev: expect.objectContaining({ path: docsQuickstartPath() }),
      next: expect.objectContaining({ path: docsCoreLoopPath() })
    });
    expect(docsPrevNext(docsCoreLoopPath())).toEqual({
      prev: expect.objectContaining({ path: docsSetupPromptsPath() }),
      next: expect.objectContaining({ path: docsAuthenticationPath() })
    });
    expect(docsPrevNext(docsAuthenticationPath())).toEqual({
      prev: expect.objectContaining({ path: docsCoreLoopPath() }),
      next: expect.objectContaining({ path: docsCodingAgentsPath() })
    });
    expect(docsPrevNext(docsCodingAgentsPath())).toEqual({
      prev: expect.objectContaining({ path: docsAuthenticationPath() }),
      next: expect.objectContaining({ path: docsModelsPath() })
    });
    expect(docsPrevNext(docsAnthropicPath())).toEqual({
      prev: expect.objectContaining({ path: docsModelsPath() }),
      next: expect.objectContaining({ path: docsErrorsPath() })
    });
    expect(docsPrevNext(docsBillingPath())).toEqual({
      prev: expect.objectContaining({ path: docsErrorsPath() }),
      next: expect.objectContaining({ path: docsTelemetryPath() })
    });
    expect(docsPrevNext(docsReferencePath())).toEqual({
      prev: expect.objectContaining({ path: docsTelemetryPath() }),
      next: null
    });
    // The unlisted internal page and foreign paths render no reading-order links.
    expect(docsPrevNext(docsInternalPath())).toEqual({ prev: null, next: null });
    expect(docsPrevNext("/models")).toEqual({ prev: null, next: null });
  });
});
