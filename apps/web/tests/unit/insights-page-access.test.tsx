import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// /insights is a signed-out storefront surface: the page renders a locked
// teaser (<InsightsLocked/>) inviting the visitor to sign in, and reads no
// account-scoped data without a session. This asserts the teaser renders and
// that the org resolver and data source are never reached (both throw).
const getAuthenticatedUser = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  usePathname: () => "/insights",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));
vi.mock("@/lib/auth/server", () => ({ getAuthenticatedUser }));
vi.mock("@/lib/active-org", () => ({
  resolveActiveOrg: vi.fn(() => {
    throw new Error("resolveActiveOrg must not run signed out");
  })
}));
vi.mock("@/lib/data-source", () => ({
  getDataSource: vi.fn(() => {
    throw new Error("getDataSource must not run signed out");
  })
}));

import InsightsPage from "@/app/(workspace)/insights/page";
import { LoginModalProvider } from "@/components/auth/login-modal-context";

function pageProps() {
  return { searchParams: Promise.resolve({}) };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthenticatedUser.mockResolvedValue(null);
});

describe("insights page (signed out)", () => {
  it("renders the locked teaser without resolving an org or building a data source", async () => {
    const ui = await InsightsPage(pageProps());
    render(<LoginModalProvider isAuthenticated={false}>{ui}</LoginModalProvider>);
    // The locked teaser reached the browser instead of a /signin bounce.
    expect(screen.getByRole("heading", { name: "Query your own usage" })).toBeInTheDocument();
  });
});
