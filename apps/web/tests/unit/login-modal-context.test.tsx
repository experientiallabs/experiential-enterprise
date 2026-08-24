import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const refresh = vi.fn();
const replace = vi.fn();
let searchParams = new URLSearchParams();
let pathname = "/playground";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push, refresh, replace }),
  useSearchParams: () => searchParams
}));

import { LoginModalProvider, useLoginModal } from "@/components/auth/login-modal-context";

/** A gated surface: the playground-send stand-in every consumer copies. */
function GatedAction({ action }: { action: () => void }) {
  const { open, requireAuth } = useLoginModal();
  return (
    <div>
      <button onClick={() => requireAuth(action)} type="button">
        Send
      </button>
      <button onClick={open} type="button">
        Log in
      </button>
    </div>
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

/** The full plaintext key the mint route returns for a fresh org. */
const MINTED_SECRET = "xpl_" + "m".repeat(40);

/**
 * fetch stub for a RETURNING passwordless login: enter email -> code -> verify
 * returns created:false, so the modal runs the pending action and closes with no
 * celebration. The /api/welcome and /api/keys branches serve the success step
 * for the OAuth-welcome-return tests (which are already signed in).
 */
function stubModalFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/auth/otp") {
      return Promise.resolve(jsonResponse(200, { ok: true }));
    }
    if (url === "/auth/otp/verify") {
      return Promise.resolve(jsonResponse(200, { created: false, ok: true }));
    }
    if (url === "/api/welcome") {
      return Promise.resolve(
        jsonResponse(200, {
          org: { id: "org-1", slug: "acme" },
          apiKey: null,
          canManageKeys: true,
          credit: { grantedUsd: 20, billableUsd: 0 }
        })
      );
    }
    if (url === "/api/keys") {
      return Promise.resolve(jsonResponse(200, { secret: MINTED_SECRET }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderGated(isAuthenticated: boolean, action = vi.fn()) {
  render(
    <LoginModalProvider isAuthenticated={isAuthenticated}>
      <GatedAction action={action} />
    </LoginModalProvider>
  );
  return action;
}

async function loginThroughModal() {
  // Emailed-code flow: the trial form defaults to password mode, so switch
  // first; then enter email -> Continue sends the code -> enter it -> Sign in.
  // A returning login (verify created:false) runs the pending action and
  // closes without a celebration.
  fireEvent.click(screen.getByRole("button", { name: "Sign in with email code" }));
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.co" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  const codeInput = await screen.findByLabelText("Sign-in code");
  fireEvent.change(codeInput, { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(screen.queryByTestId("login-modal")).not.toBeInTheDocument());
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  searchParams = new URLSearchParams();
  pathname = "/playground";
});

describe("useLoginModal / requireAuth", () => {
  it("runs the action immediately for a signed-in user, no modal", () => {
    const action = renderGated(true);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("login-modal")).not.toBeInTheDocument();
  });

  it("gates signed-out: modal in place, action runs after the in-modal login", async () => {
    stubModalFetch();
    const action = renderGated(false);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(action).not.toHaveBeenCalled();
    expect(screen.getByTestId("login-modal")).toBeInTheDocument();

    await loginThroughModal();

    // A returning login runs the pending action and closes — no celebration
    // modal pops on an ordinary sign-in.
    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("login-success-step")).not.toBeInTheDocument();
    expect(screen.queryByTestId("login-modal")).not.toBeInTheDocument();
    // The server tree re-renders to reflect the new session.
    expect(refresh).toHaveBeenCalled();
  });

  it("pops the welcome success step for a newly created account", async () => {
    // A brand-new account (created:true) gets the first-time celebration: its
    // freshly minted key with a copy control and the grant line.
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/auth/otp") {
        return Promise.resolve(jsonResponse(200, { ok: true }));
      }
      if (url === "/auth/otp/verify") {
        // Entering the emailed code on a brand-new address creates AND verifies
        // the account in one step (created:true -> first-time celebration).
        return Promise.resolve(jsonResponse(200, { created: true, ok: true }));
      }
      if (url === "/api/welcome") {
        return Promise.resolve(
          jsonResponse(200, {
            org: { id: "org-1", slug: "acme" },
            apiKey: null,
            canManageKeys: true,
            credit: { grantedUsd: 20, billableUsd: 0 }
          })
        );
      }
      if (url === "/api/keys") {
        return Promise.resolve(jsonResponse(200, { secret: MINTED_SECRET }));
      }
      return Promise.resolve(jsonResponse(404, {}));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderGated(false);

    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in with email code" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@b.co" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const codeInput = await screen.findByLabelText("Sign-in code");
    fireEvent.change(codeInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByTestId("login-success-step");
    await screen.findByText(MINTED_SECRET);
    expect(screen.getByRole("button", { name: "Copy API key" })).toBeInTheDocument();
    // The welcome grant is the hero figure of the reveal.
    expect(await screen.findByTestId("welcome-credits-line")).toHaveTextContent("$20");
  });

  it("never dead-ends the password 401: the modal offers the emailed-code signup path", async () => {
    // the product owner hit this live: an email with no account, tried in the modal's
    // password mode, ended at "Invalid email or password." with nowhere to go.
    // The modal hosts the SAME AuthForm as /signin, so the rejection must offer
    // the emailed-code flow — which creates the account on first use — and a
    // created account still gets the first-key celebration.
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/auth/password/signin") {
        return Promise.resolve(jsonResponse(401, { error: "Invalid email or password." }));
      }
      if (url === "/auth/otp") {
        return Promise.resolve(jsonResponse(200, { ok: true }));
      }
      if (url === "/auth/otp/verify") {
        return Promise.resolve(jsonResponse(200, { created: true, ok: true }));
      }
      if (url === "/api/welcome") {
        return Promise.resolve(
          jsonResponse(200, {
            org: { id: "org-1", slug: "acme" },
            apiKey: null,
            canManageKeys: true,
            credit: { grantedUsd: 20, billableUsd: 0 }
          })
        );
      }
      if (url === "/api/keys") {
        return Promise.resolve(jsonResponse(200, { secret: MINTED_SECRET }));
      }
      return Promise.resolve(jsonResponse(404, {}));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderGated(false);

    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "noacct@b.co" } });
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "guess1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Invalid email or password.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Email me a sign-in code" }));

    const codeInput = await screen.findByLabelText("Sign-in code");
    fireEvent.change(codeInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // created:true advances the modal to the first-key welcome reveal, exactly
    // like a code-first signup.
    await screen.findByTestId("login-success-step");
    await screen.findByText(MINTED_SECRET);
  });

  it("treats a login as signed-in immediately: the next gated click runs", async () => {
    stubModalFetch();
    const action = renderGated(false);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await loginThroughModal();
    action.mockClear();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("login-modal")).not.toBeInTheDocument();

    // The server prop still says signed-out (refresh pending); the provider
    // must not re-gate an action the session can already perform.
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("open() is a no-op when already signed in", () => {
    renderGated(true);

    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(screen.queryByTestId("login-modal")).not.toBeInTheDocument();
  });

  it("sends OAuth on a round-trip back to this page with the welcome marker", () => {
    stubModalFetch();
    searchParams = new URLSearchParams("model=coding");
    renderGated(false);

    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    const google = screen.getByRole("link", { name: /Continue with Google/ });
    expect(google).toHaveAttribute(
      "href",
      `/auth/oauth/google?next=${encodeURIComponent("/playground?model=coding&welcome=1")}`
    );
  });
});

describe("the OAuth welcome return", () => {
  it("re-opens the modal on the success step and strips the marker", async () => {
    stubModalFetch();
    searchParams = new URLSearchParams("model=coding&welcome=1");
    renderGated(true);

    await screen.findByTestId("login-success-step");
    expect(replace).toHaveBeenCalledWith("/playground?model=coding", { scroll: false });
  });

  it("ignores a hand-typed marker while signed out", async () => {
    stubModalFetch();
    searchParams = new URLSearchParams("welcome=1");
    renderGated(false);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/playground", { scroll: false }));
    expect(screen.queryByTestId("login-modal")).not.toBeInTheDocument();
  });
});
