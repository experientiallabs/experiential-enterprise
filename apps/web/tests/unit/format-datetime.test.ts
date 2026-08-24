import { describe, expect, it } from "vitest";

import { formatClockTime, formatDateTime, formatDateTimeWithYear } from "@/lib/format";

// Newer ICU separates the time from the AM/PM marker with a narrow no-break
// space; normalize so assertions hold across Node versions.
function plain(value: string): string {
  return value.replace(/\u202f/g, " ");
}

describe("formatDateTime", () => {
  it("renders deterministic text for the UTC zone used during SSR/hydration", () => {
    expect(plain(formatDateTime("2026-06-01T18:30:00.000Z", "UTC"))).toBe("Jun 1, 6:30 PM");
  });

  it("renders in the requested viewer time zone", () => {
    expect(plain(formatDateTime("2026-06-01T18:30:00.000Z", "America/Los_Angeles"))).toBe(
      "Jun 1, 11:30 AM"
    );
    expect(plain(formatDateTime("2026-06-01T18:30:00.000Z", "Asia/Tokyo"))).toBe("Jun 2, 3:30 AM");
  });
});

describe("formatDateTimeWithYear", () => {
  it("keeps the year visible for provenance fields", () => {
    expect(plain(formatDateTimeWithYear("2025-06-01T18:30:00.000Z", "UTC"))).toBe(
      "Jun 1, 2025, 6:30 PM"
    );
  });
});

describe("formatClockTime", () => {
  it("renders deterministic text for the UTC zone used during SSR/hydration", () => {
    expect(plain(formatClockTime("2026-06-01T18:30:05.000Z", "UTC"))).toBe("06:30:05 PM");
  });

  it("renders in the requested viewer time zone", () => {
    expect(plain(formatClockTime("2026-06-01T18:30:05.000Z", "America/Los_Angeles"))).toBe(
      "11:30:05 AM"
    );
  });

  it("returns an empty string for unparseable input", () => {
    expect(formatClockTime("not-a-timestamp", "UTC")).toBe("");
  });
});
