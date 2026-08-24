import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const createClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/config", () => ({
  loadSupabaseAuthSettings: () => ({ anonKey: "anon", url: "http://supabase.local" })
}));
vi.mock("@supabase/supabase-js", () => ({ createClient }));

import {
  sendPasswordResetEmail,
  sendSigninCode,
  sendSignupCode,
  sendVerificationEmail
} from "@/lib/auth/verification";

function adminWithGenerateLink(result: { data: unknown; error: unknown }): SupabaseClient {
  return {
    auth: { admin: { generateLink: vi.fn().mockResolvedValue(result) } }
  } as unknown as SupabaseClient;
}

describe("sendVerificationEmail", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("generates a magic link and dispatches it via Resend", async () => {
    const admin = adminWithGenerateLink({
      data: { properties: { hashed_token: "hashed-xyz" } },
      error: null
    });

    const result = await sendVerificationEmail(admin, "founder@startup.com", "https://platform.example.ai");

    expect(result).toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("api.resend.com");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.to).toEqual(["founder@startup.com"]);
    // The emailed link points at the real origin's /auth/callback with the
    // admin-minted token, so clicking it verifies the email (unlocks credits).
    expect(body.html).toContain("https://platform.example.ai/auth/callback");
    expect(body.html).toContain("token_hash=hashed-xyz");
    expect(body.html).toContain("type=magiclink");
  });

  it("generates a RECOVERY link to the set-password page and dispatches it via Resend", async () => {
    const admin = adminWithGenerateLink({
      data: { properties: { hashed_token: "rec-token" } },
      error: null
    });

    const result = await sendPasswordResetEmail(
      admin,
      "founder@startup.com",
      "https://platform.example.ai"
    );

    expect(result).toEqual({ sent: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("api.resend.com");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.to).toEqual(["founder@startup.com"]);
    // The link runs through /auth/callback (verifyOtp type=recovery) and lands on
    // the set-password page.
    expect(body.html).toContain("https://platform.example.ai/auth/callback");
    expect(body.html).toContain("token_hash=rec-token");
    expect(body.html).toContain("type=recovery");
    expect(body.html).toContain("next=%2Freset-password");
  });

  it("reports a failure when the recovery generateLink returns no token", async () => {
    const admin = adminWithGenerateLink({ data: null, error: new Error("down") });
    const result = await sendPasswordResetEmail(admin, "founder@startup.com", "https://x.ai");
    expect(result.sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a failure when generateLink returns no token, without throwing", async () => {
    const admin = adminWithGenerateLink({ data: null, error: new Error("down") });

    const result = await sendVerificationEmail(admin, "founder@startup.com", "https://x.ai");

    expect(result.sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a failure when RESEND_API_KEY is unset", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const admin = adminWithGenerateLink({
      data: { properties: { hashed_token: "hashed-xyz" } },
      error: null
    });

    const result = await sendVerificationEmail(admin, "founder@startup.com", "https://x.ai");

    expect(result.sent).toBe(false);
  });
});

describe("sendSigninCode", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends an emailed sign-in code via GoTrue OTP, never creating a user", async () => {
    const signInWithOtp = vi.fn().mockResolvedValue({ data: {}, error: null });
    createClient.mockReturnValue({ auth: { signInWithOtp } });

    const ok = await sendSigninCode("member@startup.com", "https://platform.example.ai");

    expect(ok).toBe(true);
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "member@startup.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: "https://platform.example.ai/auth/callback"
      }
    });
  });

  it("returns false when the mailer errors", async () => {
    const signInWithOtp = vi.fn().mockResolvedValue({ data: {}, error: new Error("smtp down") });
    createClient.mockReturnValue({ auth: { signInWithOtp } });

    expect(await sendSigninCode("member@startup.com", "https://platform.example.ai")).toBe(false);
  });

  it("allows the marketing handoff to create an account after code verification", async () => {
    const signInWithOtp = vi.fn().mockResolvedValue({ data: {}, error: null });
    createClient.mockReturnValue({ auth: { signInWithOtp } });

    expect(await sendSignupCode("founder@startup.com", "https://platform.example.ai")).toBe(true);
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "founder@startup.com",
      options: {
        shouldCreateUser: true,
        emailRedirectTo: "https://platform.example.ai/auth/callback"
      }
    });
  });
});
