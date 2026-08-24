import { afterEach, describe, expect, it, vi } from "vitest";

import { sendInvitationEmail, sendOrgInviteEmail } from "@/lib/admin/invite-email";

const INPUT = {
  to: "invitee@example.com",
  orgName: "Acme <Traces>",
  inviteUrl: "https://app.example.com/signin?invite=tok-123"
};

describe("sendOrgInviteEmail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("names the organization and role, linking the tokened signup URL", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));

    const result = await sendOrgInviteEmail({
      to: "joiner@example.com",
      orgName: "Acme & Co",
      role: "user",
      inviteUrl: "https://app.example.com/signin?invite=tok-456"
    });

    expect(result).toEqual({ sent: true });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      to: string[];
      subject: string;
      html: string;
    };
    expect(body.to).toEqual(["joiner@example.com"]);
    expect(body.subject).toBe("You've been invited to join Acme & Co");
    // Org names are HTML-escaped into the body.
    expect(body.html).toContain("Acme &amp; Co");
    expect(body.html).toContain("user");
    expect(body.html).toContain("https://app.example.com/signin?invite=tok-456");
  });
});

describe("sendInvitationEmail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("reports unsent when RESEND_API_KEY is missing", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const result = await sendInvitationEmail(INPUT);

    expect(result).toEqual({ sent: false, reason: "RESEND_API_KEY is not configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the invite email through the Resend API", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));

    const result = await sendInvitationEmail(INPUT);

    expect(result).toEqual({ sent: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key");
    const body = JSON.parse(String(init?.body)) as {
      from: string;
      to: string[];
      subject: string;
      html: string;
    };
    expect(body.to).toEqual(["invitee@example.com"]);
    expect(body.from).toBe("Experiential Labs <members@experientiallabs.ai>");
    expect(body.subject).toContain("Acme <Traces>");
    // Organization names are HTML-escaped into the body.
    expect(body.html).toContain("Acme &lt;Traces&gt;");
    expect(body.html).toContain(INPUT.inviteUrl);
  });

  it("honors a configured from address", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("EXPLABS_EMAIL_FROM", "Invites <invites@experientiallabs.ai>");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));

    await sendInvitationEmail(INPUT);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { from: string };
    expect(body.from).toBe("Invites <invites@experientiallabs.ai>");
  });

  it("surfaces Resend rejections as unsent with the API message", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "domain not verified" }), { status: 403 })
    );

    const result = await sendInvitationEmail(INPUT);

    expect(result).toEqual({
      sent: false,
      reason: "Resend rejected the email: domain not verified"
    });
  });

  it("surfaces network failures as unsent", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("socket hang up"));

    const result = await sendInvitationEmail(INPUT);

    expect(result).toEqual({ sent: false, reason: "Resend request failed: socket hang up" });
  });
});
