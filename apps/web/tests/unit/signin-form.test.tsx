import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const refresh = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
  useSearchParams: () => searchParams
}));

import { SigninForm } from "@/app/signin/SigninForm";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

// The passwordless flow: enter email -> Continue sends a code (/auth/otp) ->
// enter the code -> /auth/otp/verify returns { created } and signs in.
function stubOtp(verify: { status: number; payload: unknown }) {
  const mock = vi.fn(async (url: unknown, _init?: RequestInit) => {
    const target = String(url);
    if (target === "/auth/otp") {
      return jsonResponse(200, { ok: true });
    }
    if (target === "/auth/otp/verify") {
      return jsonResponse(verify.status, verify.payload);
    }
    throw new Error(`Unexpected fetch: ${target}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function signInWithCode(email = "new.user@example.com") {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  const codeInput = await screen.findByLabelText("Sign-in code");
  fireEvent.change(codeInput, { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  searchParams = new URLSearchParams();
});

describe("SigninForm", () => {
  it("signs in with an emailed code and navigates to the requested destination", async () => {
    searchParams = new URLSearchParams("next=/orgs");
    const fetchMock = stubOtp({ status: 200, payload: { ok: true, created: false } });
    render(<SigninForm inviteToken={null} prefillEmail={null} />);

    await signInWithCode();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/orgs"));
    const otpBody = JSON.parse(
      (fetchMock.mock.calls.find(([url]) => url === "/auth/otp")?.[1] as RequestInit).body as string
    );
    expect(otpBody).toMatchObject({ inviteToken: null });
    expect(window.localStorage.getItem("explabs.last-auth-method")).toBe("email_code");
  });

  it("sends a just-created account to the Overview even from a deep link", async () => {
    searchParams = new URLSearchParams("next=/orgs");
    stubOtp({ status: 200, payload: { ok: true, created: true } });
    render(<SigninForm inviteToken={null} prefillEmail={null} />);

    await signInWithCode();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/overview"));
  });

  it("defaults the signed-in destination to the Overview in one hop", async () => {
    stubOtp({ status: 200, payload: { ok: true, created: false } });
    render(<SigninForm inviteToken={null} prefillEmail={null} />);

    await signInWithCode();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/overview"));
  });

  it("carries the invite token on the code request", async () => {
    const fetchMock = stubOtp({ status: 200, payload: { ok: true, created: true } });
    render(<SigninForm inviteToken="tok-1" prefillEmail={null} />);

    await signInWithCode();

    await waitFor(() => expect(push).toHaveBeenCalled());
    const otpBody = JSON.parse(
      (fetchMock.mock.calls.find(([url]) => url === "/auth/otp")?.[1] as RequestInit).body as string
    );
    expect(otpBody).toMatchObject({ inviteToken: "tok-1" });
  });

  it("opens directly on the code stage when bounced from /signup (?sent=1)", async () => {
    searchParams = new URLSearchParams("sent=1");
    stubOtp({ status: 200, payload: { ok: true, created: false } });
    render(<SigninForm inviteToken={null} prefillEmail="founder@company.com" />);

    // No Continue click needed: the code stage is already open for the address
    // /signup emailed a code to.
    expect(screen.getByLabelText("Sign-in code")).toBeInTheDocument();
    expect(
      screen.getByText("Enter the 6-digit code emailed to founder@company.com.")
    ).toBeInTheDocument();
  });

  it("requires an explicit code request for a signup marker and preserves the welcome reveal", async () => {
    searchParams = new URLSearchParams("signup=1");
    const fetchMock = stubOtp({ status: 200, payload: { ok: true, created: true } });
    render(<SigninForm inviteToken={null} prefillEmail="founder@company.com" />);

    expect(screen.queryByLabelText("Sign-in code")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await signInWithCode("founder@company.com");

    await waitFor(() => expect(push).toHaveBeenCalledWith("/overview?welcome=1"));
  });

  it("surfaces a bad code without navigating", async () => {
    stubOtp({ status: 400, payload: { code: "otp_invalid", error: "That code is invalid." } });
    render(<SigninForm inviteToken={null} prefillEmail={null} />);

    await signInWithCode();

    expect(await screen.findByText("That code is invalid.")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("reports a network failure instead of failing silently", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    render(<SigninForm inviteToken={null} prefillEmail={null} />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByText("Couldn't reach the server. Check your connection and try again.")
    ).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
