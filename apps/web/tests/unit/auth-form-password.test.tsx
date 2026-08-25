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
  it("stays passwordless by default: the password field is hidden until toggled", () => {
    stubFetch();
    renderForm();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    // The opt-in toggle is present.
    expect(screen.getByRole("button", { name: "Sign in with password" })).toBeInTheDocument();
  });

  it("signs in with a password after switching modes", async () => {
    const fetchMock = stubFetch();
    const onSuccess = renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Sign in with password" }));
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

  it("wrong_password shows a specific message plus the reset and code offers", async () => {
    stubFetch({
      signin: { status: 401, payload: { code: "wrong_password", error: "Wrong password." } }
    });
    const onSuccess = renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Sign in with password" }));
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(/Wrong password\./)).toBeInTheDocument();
    // The reset affordance (existing inline button) and the secondary code link.
    expect(screen.getByRole("button", { name: "Forgot password?" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign in with an emailed code instead" })
    ).toBeInTheDocument();
    // Not the no_account branch, and never the old always-on double message.
    expect(screen.queryByRole("button", { name: "Create an account" })).not.toBeInTheDocument();
    expect(screen.queryByText(/No account yet, or never set a password/)).not.toBeInTheDocument();
    expect(screen.queryByText("Invalid email or password.")).not.toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("no_account reveals the Create-an-account affordance and hides reset", async () => {
    stubFetch({
      signin: { status: 401, payload: { code: "no_account", error: "No account found for that email." } }
    });
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Sign in with password" }));
    expect(screen.queryByRole("button", { name: "Create an account" })).not.toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("button", { name: "Create an account" })).toBeInTheDocument();
    // No account to reset, so the reset affordance is hidden here.
    expect(screen.queryByRole("button", { name: "Forgot password?" })).not.toBeInTheDocument();
    // Not the wrong_password branch, and never the old always-on double message.
    expect(screen.queryByText(/Wrong password\./)).not.toBeInTheDocument();
    expect(screen.queryByText(/No account yet, or never set a password/)).not.toBeInTheDocument();
  });

  it("routes Create-an-account through the same /auth/otp signup flow as code mode", async () => {
    const fetchMock = stubFetch({
      signin: { status: 401, payload: { code: "no_account", error: "No account found for that email." } },
      // A brand-new address: entering the emailed code creates the account.
      verify: { status: 200, payload: { ok: true, created: true } }
    });
    const onSuccess = renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Sign in with password" }));
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create an account" }));

    // Same send as pressing Continue in code mode: /auth/otp with the typed
    // address, landing on the code-entry stage bound to it.
    const codeInput = await screen.findByLabelText("Sign-in code");
    const otpCall = fetchMock.mock.calls.find(([url]) => url === "/auth/otp");
    expect(JSON.parse((otpCall?.[1] as RequestInit).body as string)).toEqual({
      email: "founder@company.com",
      inviteToken: null
    });
    expect(screen.queryByRole("button", { name: "Create an account" })).not.toBeInTheDocument();

    fireEvent.change(codeInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // The verify created the account: the same signup logic /signin's code flow
    // uses, surfaced as created:true so the host can celebrate.
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ created: true }));
  });

  it("requests a reset link from Forgot password? with a neutral notice", async () => {
    const fetchMock = stubFetch();
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Sign in with password" }));
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

  it("can switch back to the email-code flow", async () => {
    stubFetch();
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Sign in with password" }));
    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in with email code" }));
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });
});

describe("AuthForm OTP send de-dupe", () => {
  function otpCalls(mock: ReturnType<typeof stubFetch>): number {
    return mock.mock.calls.filter(([url]) => url === "/auth/otp").length;
  }

  it("sends the OTP exactly once when the code stage is entered, even on a double Continue", async () => {
    // The double-code bug: a second requestCode for the same address fires
    // GoTrue again, which reuses the same token and emails a second identical
    // code. A rapid double Continue must still send exactly once.
    const fetchMock = stubFetch();
    renderForm();

    const continueButton = screen.getByRole("button", { name: "Continue" });
    fireEvent.click(continueButton);
    fireEvent.click(continueButton);

    await screen.findByLabelText("Sign-in code");
    expect(otpCalls(fetchMock)).toBe(1);
  });

  it("does not re-send when Create-an-account routes into the code flow", async () => {
    const fetchMock = stubFetch({
      signin: { status: 401, payload: { code: "no_account", error: "No account found." } }
    });
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Sign in with password" }));
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create an account" }));

    await screen.findByLabelText("Sign-in code");
    expect(otpCalls(fetchMock)).toBe(1);
  });

  it("Resend code deliberately sends another OTP", async () => {
    const fetchMock = stubFetch();
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByLabelText("Sign-in code");
    expect(otpCalls(fetchMock)).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Resend code" }));
    await waitFor(() => expect(otpCalls(fetchMock)).toBe(2));
  });
});
