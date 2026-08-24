import { describe, expect, it } from "vitest";

import { webBaseUrlFromHeaders } from "@/lib/public-web-url";

function headers(map: Record<string, string>) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

describe("webBaseUrlFromHeaders", () => {
  it("uses the forwarded host and proto", () => {
    expect(
      webBaseUrlFromHeaders(
        headers({ "x-forwarded-host": "app.example.com", "x-forwarded-proto": "https" })
      )
    ).toBe("https://app.example.com");
  });

  it("falls back to host and http when not forwarded", () => {
    expect(webBaseUrlFromHeaders(headers({ host: "localhost:3400" }))).toBe(
      "http://localhost:3400"
    );
  });

  it("takes only the first hop of a comma-chained forwarded header", () => {
    // Multiple proxies each append, producing "client, edge, internal". Using
    // the whole chain would yield an invalid origin.
    expect(
      webBaseUrlFromHeaders(
        headers({
          "x-forwarded-host": "app.example.com, edge.internal, pod.internal",
          "x-forwarded-proto": "https, http"
        })
      )
    ).toBe("https://app.example.com");
  });

  it("ignores an empty forwarded host and falls back to host", () => {
    expect(
      webBaseUrlFromHeaders(headers({ "x-forwarded-host": "  ", host: "app.example.com" }))
    ).toBe("http://app.example.com");
  });

  it("returns undefined with no host at all", () => {
    expect(webBaseUrlFromHeaders(headers({}))).toBeUndefined();
  });
});
