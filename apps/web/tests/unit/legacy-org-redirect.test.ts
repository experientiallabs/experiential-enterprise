import { beforeEach, describe, expect, it, vi } from "vitest";

// Next's redirect()/permanentRedirect()/notFound() all throw; mirror that so
// the catch-all stops at the first branch it hits, the way it does in prod.
const redirect = vi.hoisted(() =>
  vi.fn((target: string): never => {
    throw new Error(`redirect:${target}`);
  })
);
const permanentRedirect = vi.hoisted(() =>
  vi.fn((target: string): never => {
    throw new Error(`permanentRedirect:${target}`);
  })
);
const notFound = vi.hoisted(() =>
  vi.fn((): never => {
    throw new Error("notFound");
  })
);
const findAuthorizedOrg = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ redirect, permanentRedirect, notFound }));
vi.mock("@/lib/active-org", () => ({ findAuthorizedOrg }));

import LegacyOrgPage from "@/app/[orgSlug]/[[...rest]]/page";

type Params = { orgSlug: string; rest?: string[] };

async function run(params: Params, searchParams: Record<string, string | string[]> = {}): Promise<string> {
  try {
    await LegacyOrgPage({
      params: Promise.resolve(params),
      searchParams: Promise.resolve(searchParams)
    });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the page to redirect or 404");
}

beforeEach(() => {
  vi.clearAllMocks();
  findAuthorizedOrg.mockResolvedValue(null);
});

describe("legacy org catch-all", () => {
  it("redirects a bare reserved slug to its real page without an org lookup", async () => {
    // /usage is not a top-level route (the old settings section moved to
    // /credits), so it reaches the catch-all; the guard sends it there.
    expect(await run({ orgSlug: "usage" })).toBe("redirect:/credits");
    expect(findAuthorizedOrg).not.toHaveBeenCalled();
  });

  it("404s a reserved slug that carries extra path segments", async () => {
    // /logs/extra: the static /logs leaf did not match, and the reserved prefix
    // is never an org slug. ("telemetry" stays reserved too, redirecting to the
    // renamed /logs, but with extra segments it 404s the same way.)
    expect(await run({ orgSlug: "logs", rest: ["extra"] })).toBe("notFound");
    expect(await run({ orgSlug: "telemetry", rest: ["extra"] })).toBe("notFound");
    expect(findAuthorizedOrg).not.toHaveBeenCalled();
  });

  it("404s a reserved slug with no landing page", async () => {
    expect(await run({ orgSlug: "api" })).toBe("notFound");
    expect(findAuthorizedOrg).not.toHaveBeenCalled();
  });

  it("permanently redirects a real legacy org path to its root-level URL", async () => {
    findAuthorizedOrg.mockResolvedValue({ id: "p1", slug: "alpha" });
    expect(await run({ orgSlug: "alpha", rest: ["playground"] })).toBe("permanentRedirect:/playground");
  });

  it("carries the query string through a legacy redirect", async () => {
    findAuthorizedOrg.mockResolvedValue({ id: "p1", slug: "alpha" });
    expect(await run({ orgSlug: "alpha", rest: ["playground"] }, { model: "x" })).toBe(
      "permanentRedirect:/playground?model=x"
    );
  });

  it("404s an unknown first segment that is neither reserved nor an org", async () => {
    expect(await run({ orgSlug: "not-an-org", rest: ["x"] })).toBe("notFound");
    expect(findAuthorizedOrg).toHaveBeenCalledWith("not-an-org");
  });
});
