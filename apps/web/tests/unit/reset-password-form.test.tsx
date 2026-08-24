import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn() })
}));

import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";

function jsonResponse(status: number, payload: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function stubFetch(result: { status: number; payload: unknown }) {
  const mock = vi.fn(async (url: unknown, _init?: RequestInit) => {
    if (String(url) === "/auth/password/reset/confirm") {
      return jsonResponse(result.status, result.payload);
    }
    throw new Error(`Unexpected fetch: ${String(url)}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function fill(pw: string, confirm: string) {
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: pw } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: confirm } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("ResetPasswordForm", () => {
  it("sets the password and lands on the overview", async () => {
    const fetchMock = stubFetch({ status: 200, payload: { ok: true } });
    render(<ResetPasswordForm />);

    fill("brand-new-pw", "brand-new-pw");
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/overview"));
    const call = fetchMock.mock.calls[0];
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({
      password: "brand-new-pw"
    });
  });

  it("blocks a mismatch before calling the server", async () => {
    const fetchMock = stubFetch({ status: 200, payload: { ok: true } });
    render(<ResetPasswordForm />);

    fill("brand-new-pw", "different-pw");
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));

    expect(await screen.findByText("Passwords do not match.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a too-short password before calling the server", async () => {
    const fetchMock = stubFetch({ status: 200, payload: { ok: true } });
    render(<ResetPasswordForm />);

    fill("123", "123");
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));

    expect(await screen.findByText(/at least 6 characters/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces an expired recovery link with a back-to-sign-in link", async () => {
    stubFetch({
      status: 401,
      payload: { code: "no_recovery", error: "This reset link has expired. Request a new one." }
    });
    render(<ResetPasswordForm />);

    fill("brand-new-pw", "brand-new-pw");
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));

    expect(
      await screen.findByText(/This reset link has expired/i)
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/signin");
    expect(push).not.toHaveBeenCalled();
  });
});
