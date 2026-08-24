import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// /telemetry is the signed-out storefront: the page renders the full usage
// surface over deterministic DEMO data for a signed-out visitor, and only
// "see your OWN usage" requires a session. This asserts the demo actually
// renders and that no account-scoped read fires without a session — the org
// resolver and data source throw so any reach into them fails the test.
const getAuthenticatedUser = vi.hoisted(() => vi.fn());
const resolveActiveOrg = vi.hoisted(() => vi.fn());
const getDataSource = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  usePathname: () => "/logs",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));
vi.mock("@/lib/auth/server", () => ({ getAuthenticatedUser }));
vi.mock("@/lib/active-org", () => ({ resolveActiveOrg }));
vi.mock("@/lib/data-source", () => ({ getDataSource }));

import TelemetryPage from "@/app/(workspace)/logs/page";
import { LoginModalProvider } from "@/components/auth/login-modal-context";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("telemetry page (signed out)", () => {
  it("renders the demo surface without resolving an org or building a data source", async () => {
    getAuthenticatedUser.mockResolvedValue(null);
    resolveActiveOrg.mockImplementation(() => {
      throw new Error("resolveActiveOrg must not run signed out");
    });
    getDataSource.mockImplementation(() => {
      throw new Error("getDataSource must not run signed out");
    });
    const ui = await TelemetryPage({ searchParams: Promise.resolve({}) });
    render(<LoginModalProvider isAuthenticated={false}>{ui}</LoginModalProvider>);
    // The unmistakable signed-out marker: the demo surface reached the browser
    // instead of the visitor being bounced to /signin.
    expect(screen.getByText("Demo data")).toBeInTheDocument();
  });
});

describe("telemetry page (signed in)", () => {
  it("still renders when imported usage alone fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    getAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@example.com" });
    resolveActiveOrg.mockResolvedValue({ id: "org-1", slug: "acme", name: "Acme" });
    const getImportedUsage = vi.fn().mockRejectedValue(new Error("imported usage timed out"));
    getDataSource.mockReturnValue({
      getUsageTimeseries: vi.fn().mockResolvedValue({
        window: "7d",
        bucket_seconds: 3600,
        buckets: [
          {
            bucket_start: "2026-08-23T00:00:00.000Z",
            model: "claude-sonnet-4-6",
            lane: "platform",
            request_count: 2,
            error_count: 0,
            input_tokens: 100,
            output_tokens: 40,
            cost_usd: 0.01,
            estimated_cost_usd: 0
          }
        ]
      }),
      getUsageByKey: vi.fn().mockResolvedValue({ window: "7d", keys: [] }),
      getUsageByProvider: vi.fn().mockResolvedValue({ window: "7d", providers: [] }),
      listUsageRequests: vi.fn().mockResolvedValue({ requests: [], next_cursor: null }),
      getImportedUsage,
      listProjects: vi.fn().mockResolvedValue({ projects: [] })
    });

    const ui = await TelemetryPage({ searchParams: Promise.resolve({}) });
    render(<LoginModalProvider isAuthenticated>{ui}</LoginModalProvider>);

    expect(screen.getByText("Spend over time")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Imported historical spend" })).not.toBeInTheDocument();
    expect(getImportedUsage).toHaveBeenCalledWith("org-1");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
