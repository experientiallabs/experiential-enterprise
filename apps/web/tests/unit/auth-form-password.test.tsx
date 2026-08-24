import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/signin",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

import { AuthForm } from "@/components/auth/AuthForm";

function jsonResponse(status: number, payload: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function stubFetch(
  overrides: {
    signin?: { status: number; payload: unknown };
    verify?: { status: number; payload: unknown };
  } = {}
) {
  const mock = vi.fn(async (url: unknown, _init?: RequestInit) => {
    const target = String(url);
    if (target === "/auth/password/signin") {
      const s = overrides.signin ?? { status: 200, payload: { ok: true, created: false } };
      return jsonResponse(s.status, s.payload);
    }
    if (target === "/auth/password/reset") {
      return jsonResponse(200, { ok: true });
    }
    if (target === "/auth/otp") {
      return jsonResponse(200, { ok: true });
    }
    if (target === "/auth/otp/verify") {
      const verify = overrides.verify ?? { status: 200, payload: { ok: true, created: false } };
      return jsonResponse(verify.status, verify.payload);
    }
    throw new Error(`Unexpected fetch: ${target}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function renderForm(onSuccess = vi.fn()) {
  render(
    <AuthForm
      inviteToken={null}
      prefillEmail="founder@company.com"
      tone="dark"
      oauthNext="/overview"
      onSuccess={onSuccess}
    />
  );
  return onSuccess;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("AuthForm password option", () => {
  it("defaults to password sign-in with the emailed-code option as the toggle", () => {
    stubFetch();
    renderForm();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    // The emailed-code flow stays one click away for local runs.
    expect(screen.getByRole("button", { name: "Sign in with email code" })).toBeInTheDocument();
  });

  it("signs in with a password from the default mode", async () => {
    const fetchMock = stubFetch();
    const onSuccess = renderForm();

    const passwordInput = await screen.findByLabelText("Password");
    fireEvent.change(passwordInput, { target: { value: "hunter2xx" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ created: false }));
    const call = fetchMock.mock.calls.find(([url]) => url === "/auth/password/signin");
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({
      email: "founder@company.com",
      password: "hunter2xx"
    });
  });

  it("shows a uniform error for bad password credentials", async () => {
    stubFetch({ signin: { status: 401, payload: { error: "Invalid email or password." } } });
    const onSuccess = renderForm();

    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Invalid email or password.")).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("offers the emailed-code path after a rejected password attempt (no dead end)", async () => {
    // The 401 is uniform, so an email with NO account lands here too: the form
    // must offer the code flow, which creates the account on first use. The
    // offer renders on every rejection (existing account included) so it leaks
    // no account-existence signal beyond what the route already returns.
    stubFetch({ signin: { status: 401, payload: { error: "Invalid email or password." } } });
    renderForm();

    expect(screen.queryByRole("button", { name: "Email me a sign-in code" })).not.toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // Both surfaces stay up: the uniform error AND the way out of it.
    expect(await screen.findByText("Invalid email or password.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email me a sign-in code" })).toBeInTheDocument();
  });

  it("routes the rejection offer through the same /auth/otp signup flow as code mode", async () => {
    const fetchMock = stubFetch({
      signin: { status: 401, payload: { error: "Invalid email or password." } },
      // A brand-new address: entering the emailed code creates the account.
      verify: { status: 200, payload: { ok: true, created: true } }
    });
    const onSuccess = renderForm();

    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByRole("button", { name: "Email me a sign-in code" }));

    // Same send as pressing Continue in code mode: /auth/otp with the typed
    // address, landing on the code-entry stage bound to it.
    const codeInput = await screen.findByLabelText("Sign-in code");
    const otpCall = fetchMock.mock.calls.find(([url]) => url === "/auth/otp");
    expect(JSON.parse((otpCall?.[1] as RequestInit).body as string)).toEqual({
      email: "founder@company.com",
      inviteToken: null
    });
    expect(screen.queryByText("Invalid email or password.")).not.toBeInTheDocument();

    fireEvent.change(codeInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // The verify created the account — the same signup logic /signin's code
    // flow uses, surfaced as created:true so the host can celebrate.
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ created: true }));
  });

  it("requests a reset link from Forgot password? with a neutral notice", async () => {
    const fetchMock = stubFetch();
    renderForm();

    fireEvent.click(await screen.findByRole("button", { name: "Forgot password?" }));

    expect(
      await screen.findByText(
        "If an account exists for founder@company.com, a password reset link is on its way."
      )
    ).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([url]) => url === "/auth/password/reset");
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({
      email: "founder@company.com"
    });
  });

  it("can switch to the email-code flow and back", async () => {
    stubFetch();
    renderForm();

    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in with email code" }));
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in with password" }));
    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
  });
});
