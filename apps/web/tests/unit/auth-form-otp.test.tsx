import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/signin",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

import { AuthForm } from "@/components/auth/AuthForm";
import { safePrefillEmail } from "@/lib/auth/redirects";

function jsonResponse(status: number, payload: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function stubAuthFetch(overrides: { verify?: { status: number; payload: unknown } } = {}) {
  const mock = vi.fn(async (url: unknown, _init?: RequestInit) => {
    const target = String(url);
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

function renderForm(props: { prefillEmail?: string | null; onSuccess?: ReturnType<typeof vi.fn> }) {
  const onSuccess = props.onSuccess ?? vi.fn();
  render(
    <AuthForm
      inviteToken={null}
      prefillEmail={props.prefillEmail ?? null}
      tone="dark"
      oauthNext="/overview"
      onSuccess={onSuccess}
    />
  );
  // Trial build: password mode is the default; these suites cover the
  // emailed-code flow, so switch to it first.
  fireEvent.click(screen.getByRole("button", { name: "Sign in with email code" }));
  return onSuccess;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("safePrefillEmail", () => {
  it("passes a normal address through trimmed and ignores malformed input", () => {
    expect(safePrefillEmail("  founder@company.com ")).toBe("founder@company.com");
    expect(safePrefillEmail(null)).toBeNull();
    expect(safePrefillEmail("")).toBeNull();
    expect(safePrefillEmail("not-an-email")).toBeNull();
    expect(safePrefillEmail("two words@company.com")).toBeNull();
    expect(safePrefillEmail("<script>@evil.com")).toBeNull();
    expect(safePrefillEmail(`${"a".repeat(255)}@x.io`)).toBeNull();
  });
});

describe("AuthForm email-code flow", () => {
  it("code login via the toggle: no password field, Continue sends the code, code signs in", async () => {
    const fetchMock = stubAuthFetch();
    const onSuccess = renderForm({});

    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "founder@company.com" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const codeInput = await screen.findByLabelText("Sign-in code");
    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/otp",
      expect.objectContaining({ method: "POST" })
    );
    expect(
      screen.getByText("Enter the 6-digit code emailed to founder@company.com.")
    ).toBeInTheDocument();

    fireEvent.change(codeInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ created: false }));
    const verifyCall = fetchMock.mock.calls.find(([url]) => url === "/auth/otp/verify");
    expect(JSON.parse((verifyCall?.[1] as RequestInit).body as string)).toEqual({
      email: "founder@company.com",
      token: "123456"
    });
  });

  it("makes a prefilled email one click from a sent code", async () => {
    const fetchMock = stubAuthFetch();
    renderForm({ prefillEmail: "founder@company.com" });

    expect(screen.getByLabelText("Email")).toHaveValue("founder@company.com");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByLabelText("Sign-in code");
    const otpCall = fetchMock.mock.calls.find(([url]) => url === "/auth/otp");
    expect(JSON.parse((otpCall?.[1] as RequestInit).body as string)).toEqual({
      email: "founder@company.com",
      inviteToken: null
    });
  });

  it("shows the verify error for a wrong code and stays on the code stage", async () => {
    stubAuthFetch({
      verify: {
        status: 400,
        payload: { code: "otp_invalid", error: "That code is invalid or has expired." }
      }
    });
    const onSuccess = renderForm({ prefillEmail: "founder@company.com" });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(await screen.findByLabelText("Sign-in code"), {
      target: { value: "000000" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("That code is invalid or has expired.")).toBeInTheDocument();
    expect(screen.getByLabelText("Sign-in code")).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
  });

});

