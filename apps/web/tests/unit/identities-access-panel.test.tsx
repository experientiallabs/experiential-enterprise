import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IdentitiesAccessPanel } from "@/components/identities/identities-access-panel";
import type { ApiKeySummary } from "@/lib/api-keys/types";
import type { BudgetView, GrantMatrix, IdentityView } from "@/lib/identities/types";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() })
}));
vi.mock("@/components/auth/login-modal-context", () => ({
  // requireAuth runs its callback immediately (signed-in path).
  useLoginModal: () => ({ open: vi.fn(), requireAuth: (fn: () => void) => fn() })
}));

const ORG_ID = "org-uuid";
const PERIOD = "2026-08";

function identity(overrides: Partial<IdentityView> & { identity_id: string }): IdentityView {
  return {
    display_name: "Team",
    description: null,
    active: true,
    is_default: false,
    active_key_count: 0,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...overrides
  };
}

function budget(overrides: Partial<BudgetView> & { budget_id: string }): BudgetView {
  return {
    period: PERIOD,
    scope_kind: "team",
    api_key_id: null,
    identity_id: null,
    alias_id: null,
    pool_id: null,
    deployment_id: null,
    limit_micro_usd: 10_000_000,
    reserved_micro_usd: 2_000_000,
    settled_micro_usd: 3_000_000,
    remaining_micro_usd: 5_000_000,
    ...overrides
  };
}

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string) => {
    if (input.startsWith("/api/keys")) {
      return jsonResponse({ keys: [], page: 1, pageCount: 1, total: 0 });
    }
    return jsonResponse({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPanel(over?: {
  identities?: IdentityView[];
  matrix?: GrantMatrix;
  budgets?: BudgetView[];
  keys?: ApiKeySummary[];
}) {
  const identities = over?.identities ?? [
    identity({ identity_id: `org-${ORG_ID}`, display_name: "Default", is_default: true }),
    identity({ identity_id: "data-team", display_name: "Data Team", active_key_count: 2 })
  ];
  const matrix: GrantMatrix = over?.matrix ?? {
    identities,
    aliases: [
      { alias_id: "a-1", alias_name: "gpt-fast", origin: "catalog", org_scoped: false },
      { alias_id: "a-2", alias_name: "our-coder", origin: "named", org_scoped: true }
    ],
    grants: [{ identity_id: "data-team", alias_id: "a-1" }]
  };
  render(
    <IdentitiesAccessPanel
      budgets={over?.budgets ?? []}
      canManage
      identities={identities}
      keys={over?.keys ?? []}
      matrix={matrix}
      orgId={ORG_ID}
      period={PERIOD}
    />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("IdentitiesAccessPanel", () => {
  it("renders every tier after the access-control reflow: header, both budget cards, list, detail", () => {
    // The access-control page redesign (2026-08-23) moved the section header
    // into the panel and paired the two org-wide budget cards on one row;
    // this pins that every prior section survived the reflow.
    stubFetch();
    renderPanel();
    expect(screen.getByRole("heading", { name: "Identities & access" })).toBeTruthy();
    expect(screen.getByText(/Organization budget/)).toBeTruthy();
    expect(screen.getByText(/Key & model budgets/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add budget/ })).toBeTruthy();
    expect(screen.getByText("Identities")).toBeTruthy();
    expect(screen.getByPlaceholderText("New identity name")).toBeTruthy();
    // The selected identity's detail panes: keys, grants, and its own budget.
    expect(screen.getByText("API keys")).toBeTruthy();
    expect(screen.getByText("Granted models")).toBeTruthy();
    expect(screen.getByText(/Monthly budget/)).toBeTruthy();
  });

  it("lists identities and shows the default first", () => {
    stubFetch();
    renderPanel();
    expect(screen.getAllByText("Default").length).toBeGreaterThan(0);
    expect(screen.getByText("Data Team")).toBeTruthy();
  });

  it("creates an identity through the BFF", async () => {
    const fetchMock = stubFetch();
    renderPanel();
    fireEvent.change(screen.getByPlaceholderText("New identity name"), {
      target: { value: "Billing Bot" }
    });
    fireEvent.click(screen.getByRole("button", { name: /Add$/ }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            url === `/api/orgs/${ORG_ID}/identities` &&
            (init as RequestInit | undefined)?.method === "POST"
        )
      ).toBe(true);
    });
  });

  it("toggles a grant with a PUT to the grant route", async () => {
    const fetchMock = stubFetch();
    renderPanel();
    // Select the Data Team identity, then grant the currently-ungranted alias.
    fireEvent.click(screen.getByText("Data Team"));
    const ungranted = await screen.findByRole("button", { name: /our-coder/ });
    fireEvent.click(ungranted);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            url === `/api/orgs/${ORG_ID}/identities/data-team/grants/a-2` &&
            (init as RequestInit | undefined)?.method === "PUT"
        )
      ).toBe(true);
    });
  });

  it("renders a budget meter with settled, reserved, and remaining", () => {
    stubFetch();
    renderPanel({ budgets: [budget({ budget_id: "b-team" })] });
    expect(screen.getByText(/settled \$3\.00/)).toBeTruthy();
    expect(screen.getByText(/reserved \$2\.00/)).toBeTruthy();
    expect(screen.getByText(/remaining \$5\.00/)).toBeTruthy();
  });

  it("marks pinned budgets as this-month-only with the expiry hint, recurring ones as recurring", () => {
    stubFetch();
    renderPanel({
      budgets: [
        budget({ budget_id: "b-pinned", period: PERIOD }),
        budget({ budget_id: "b-recurring", period: "*" })
      ]
    });
    expect(screen.getByText("This month only")).toBeTruthy();
    expect(screen.getByText("Recurring")).toBeTruthy();
    // The must-see caveat: a pinned cap stops enforcing when its month ends.
    expect(screen.getByText(/stops enforcing when the month ends/)).toBeTruthy();
  });

  it("sets an organization budget through the BFF", async () => {
    const fetchMock = stubFetch();
    renderPanel();
    // "Set cap" exists in both the org strip and the identity detail; the org
    // strip renders first, so its editor is the one opened here.
    fireEvent.click(screen.getAllByRole("button", { name: "Set cap" })[0]);
    fireEvent.change(screen.getByLabelText(/Monthly cap for organization/), {
      target: { value: "12.50" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/orgs/${ORG_ID}/budgets` &&
          (init as RequestInit | undefined)?.method === "PUT"
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call?.[1] as RequestInit).body as string);
      expect(body).toMatchObject({
        period: PERIOD,
        scope_kind: "team",
        limit_micro_usd: 12_500_000
      });
    });
  });

  it("writes period '*' when Repeats monthly is on", async () => {
    const fetchMock = stubFetch();
    renderPanel();
    fireEvent.click(screen.getAllByRole("button", { name: "Set cap" })[0]);
    fireEvent.change(screen.getByLabelText(/Monthly cap for organization/), {
      target: { value: "40" }
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Repeats monthly/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/orgs/${ORG_ID}/budgets` &&
          (init as RequestInit | undefined)?.method === "PUT"
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call?.[1] as RequestInit).body as string);
      expect(body).toMatchObject({ period: "*", scope_kind: "team", limit_micro_usd: 40_000_000 });
    });
  });

  it("labels key and model budget rows with the key name and alias name", () => {
    stubFetch();
    renderPanel({
      budgets: [
        budget({ budget_id: "b-key", scope_kind: "key", api_key_id: "key-1" }),
        budget({ budget_id: "b-model", scope_kind: "model", alias_id: "a-1", period: "*" })
      ],
      keys: [{ id: "key-1", name: "CI key", key_prefix: "xpl_ci12", key_suffix: "f2e1" }]
    });
    expect(screen.getByText(/API key · CI key \(xpl_ci12…f2e1\)/)).toBeTruthy();
    expect(screen.getByText(/Model · gpt-fast/)).toBeTruthy();
  });

  it("adds a key-scoped budget through the scoped form", async () => {
    const fetchMock = stubFetch();
    renderPanel({
      keys: [{ id: "key-1", name: "CI key", key_prefix: "xpl_ci12", key_suffix: "f2e1" }]
    });
    fireEvent.click(screen.getByRole("button", { name: /Add budget/ }));
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "key-1" } });
    fireEvent.change(screen.getByLabelText(/Monthly cap \(USD\)/), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/orgs/${ORG_ID}/budgets` &&
          (init as RequestInit | undefined)?.method === "PUT"
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call?.[1] as RequestInit).body as string);
      expect(body).toMatchObject({
        period: PERIOD,
        scope_kind: "key",
        api_key_id: "key-1",
        limit_micro_usd: 5_000_000
      });
    });
  });
});
