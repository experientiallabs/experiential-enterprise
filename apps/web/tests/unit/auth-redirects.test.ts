import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { requestOrigin, safeNextPath } from "@/lib/auth/redirects";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("safeNextPath", () => {
  it("keeps same-origin absolute paths", () => {
    expect(safeNextPath("/orgs/abc?tab=evals")).toBe("/orgs/abc?tab=evals");
  });

  it("collapses missing or empty values to the root", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("")).toBe("/");
  });

  it("rejects external and protocol-relative targets", () => {
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath("//evil.example/phish")).toBe("/");
  });

  it("rejects backslash paths that URL-normalize to protocol-relative", () => {
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("/\\/evil.example")).toBe("/");
  });

  it("rejects relative paths", () => {
    expect(safeNextPath("orgs/abc")).toBe("/");
  });
});

// The standalone server binds 0.0.0.0:3000, so request.nextUrl.origin is the
// bind address, not the host the browser sees; these pin the recovery order.
describe("requestOrigin", () => {
  function requestWith(headers: Record<string, string>): NextRequest {
    return new NextRequest("http://0.0.0.0:3000/auth/oauth/google", { headers });
  }

  it("prefers the proxy's forwarded host and proto", () => {
    const origin = requestOrigin(
      requestWith({
        host: "0.0.0.0:3000",
        "x-forwarded-host": "app.experientiallabs.ai",
        "x-forwarded-proto": "https"
      })
    );
    expect(origin).toBe("https://app.experientiallabs.ai");
  });

  it("prefers the trusted deployment origin over an internal request host", () => {
    vi.stubEnv("EXPLABS_WEBAPP_URL", "https://deploy.example.test/");

    expect(requestOrigin(requestWith({ host: "web.default.svc.cluster.local:3000" }))).toBe(
      "https://deploy.example.test"
    );
  });

  it("ignores an invalid deployment origin and uses request headers", () => {
    vi.stubEnv("EXPLABS_WEBAPP_URL", "not a URL");

    expect(requestOrigin(requestWith({ host: "localhost:3300" }))).toBe("http://localhost:3300");
  });

  it("takes only the first entry of appended forwarded headers", () => {
    const origin = requestOrigin(
      requestWith({
        "x-forwarded-host": "app.experientiallabs.ai, spoofed.example",
        "x-forwarded-proto": "https, http"
      })
    );
    expect(origin).toBe("https://app.experientiallabs.ai");
  });

  it("falls back to the Host header the browser sent", () => {
    const origin = requestOrigin(requestWith({ host: "localhost:3300" }));
    expect(origin).toBe("http://localhost:3300");
  });

  it("never yields the 0.0.0.0 bind origin when any host header exists", () => {
    expect(requestOrigin(requestWith({ host: "localhost:3300" }))).not.toContain("0.0.0.0");
  });

  it("rejects a forwarded proto that is not a scheme", () => {
    const origin = requestOrigin(
      requestWith({ host: "localhost:3300", "x-forwarded-proto": "javascript:" })
    );
    expect(origin).toBe("http://localhost:3300");
  });

  it("survives a malformed host instead of throwing inside an auth redirect", () => {
    const origin = requestOrigin(requestWith({ "x-forwarded-host": "not a host" }));
    expect(origin).toBe("http://0.0.0.0:3000");
  });
});
