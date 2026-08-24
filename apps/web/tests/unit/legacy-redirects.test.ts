import { describe, expect, it, vi } from "vitest";

const permanentRedirect = vi.hoisted(() =>
  vi.fn((destination: string) => {
    throw new Error(`NEXT_REDIRECT:${destination}`);
  })
);
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  })
);
vi.mock("next/navigation", () => ({ permanentRedirect, notFound }));

const findAuthorizedOrg = vi.hoisted(() =>
  vi.fn(async (identifier: string) =>
    identifier === "org-1" || identifier === "org-uuid" ? { id: "org-uuid", slug: "org-1" } : null
  )
);
vi.mock("@/lib/active-org", () => ({ findAuthorizedOrg }));

import LegacyOrgSlugPage from "@/app/[orgSlug]/[[...rest]]/page";
import LegacyOrgIdPage from "@/app/orgs/[orgId]/[[...rest]]/page";

describe("legacy /{orgSlug} catch-all", () => {
  it("drops the org segment and redirects to the root path", async () => {
    await expect(
      LegacyOrgSlugPage({ params: Promise.resolve({ orgSlug: "org-1", rest: ["models", "m1"] }), searchParams: Promise.resolve({}) })
    ).rejects.toThrow("NEXT_REDIRECT:/models/m1");
  });

  it("404s unknown or unauthorized org slugs", async () => {
    await expect(
      LegacyOrgSlugPage({ params: Promise.resolve({ orgSlug: "not-mine", rest: ["models"] }), searchParams: Promise.resolve({}) })
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("collapses crafted off-origin redirect targets to the app root", async () => {
    // "/{org}/%5Cevil.com" decodes to a backslash segment; browsers normalize
    // "/\evil.com" to a protocol-relative external redirect if passed through.
    await expect(
      LegacyOrgSlugPage({ params: Promise.resolve({ orgSlug: "org-1", rest: ["\\evil.com"] }), searchParams: Promise.resolve({}) })
    ).rejects.toThrow(/NEXT_REDIRECT:\/$/);
    await expect(
      LegacyOrgSlugPage({ params: Promise.resolve({ orgSlug: "org-1", rest: ["", "evil.com"] }), searchParams: Promise.resolve({}) })
    ).rejects.toThrow(/NEXT_REDIRECT:\/$/);
  });
});

describe("legacy /{orgSlug} catch-all query preservation", () => {
  it("keeps the query string across the redirect", async () => {
    await expect(
      LegacyOrgSlugPage({
        params: Promise.resolve({ orgSlug: "org-1", rest: ["playground"] }),
        searchParams: Promise.resolve({ model: "support-prod" })
      })
    ).rejects.toThrow("NEXT_REDIRECT:/playground?model=support-prod");
  });
});

describe("legacy /orgs/{id} catch-all", () => {
  it("redirects straight to the root path", async () => {
    await expect(
      LegacyOrgIdPage({ params: Promise.resolve({ orgId: "org-uuid", rest: ["usage"] }), searchParams: Promise.resolve({}) })
    ).rejects.toThrow("NEXT_REDIRECT:/usage");
  });

  it("collapses crafted off-origin redirect targets to the app root", async () => {
    await expect(
      LegacyOrgIdPage({ params: Promise.resolve({ orgId: "org-uuid", rest: ["\\evil.com"] }), searchParams: Promise.resolve({}) })
    ).rejects.toThrow(/NEXT_REDIRECT:\/$/);
  });
});
