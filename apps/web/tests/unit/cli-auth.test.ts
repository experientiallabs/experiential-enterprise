import { describe, expect, it } from "vitest";

import {
  buildLoopbackCallbackUrl,
  parseLoopbackPort,
  parseState,
  suggestedKeyName
} from "@/lib/api-keys/cli-auth";

describe("parseLoopbackPort", () => {
  it.each([
    ["1024", 1024],
    ["8321", 8321],
    ["65535", 65535]
  ])("accepts %s", (raw, expected) => {
    expect(parseLoopbackPort(raw)).toBe(expected);
  });

  it.each([
    ["privileged", "80"],
    ["out of range", "65536"],
    ["not a number", "http"],
    ["negative", "-1"],
    ["decorated", "8321/callback"],
    ["missing", undefined]
  ])("rejects %s", (_label, raw) => {
    expect(parseLoopbackPort(raw)).toBeNull();
  });
});

describe("parseState", () => {
  it("accepts a token_urlsafe nonce", () => {
    expect(parseState("q3zX-_9abc")).toBe("q3zX-_9abc");
  });

  it.each([
    ["missing", undefined],
    ["blank", "  "],
    ["overlong", "a".repeat(129)],
    ["url-breaking characters", "abc&state=evil"]
  ])("rejects %s", (_label, raw) => {
    expect(parseState(raw)).toBeNull();
  });
});

describe("buildLoopbackCallbackUrl", () => {
  it("targets loopback only and escapes the token and state", () => {
    const url = buildLoopbackCallbackUrl(8321, "xpl_abc&def", "st_1");
    expect(url).toBe("http://127.0.0.1:8321/callback?token=xpl_abc%26def&state=st_1");
  });
});

describe("suggestedKeyName", () => {
  it("uses the CLI-provided name when present", () => {
    expect(suggestedKeyName(" wmh on mac-studio ")).toBe("wmh on mac-studio");
  });

  it("falls back and caps length", () => {
    expect(suggestedKeyName(undefined)).toBe("wmo CLI");
    expect(suggestedKeyName("x".repeat(200))).toHaveLength(80);
  });
});
