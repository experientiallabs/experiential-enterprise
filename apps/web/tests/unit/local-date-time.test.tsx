import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LocalDateTime, useDisplayTimeZone } from "@/components/ui/LocalDateTime";
import { formatDateTime, formatDateTimeWithYear } from "@/lib/format";

const ISO = "2026-06-01T18:30:00.000Z";

// setup.ts pins TZ=America/New_York, so the browser zone differs from the
// "UTC" server snapshot and these tests exercise the real hydration swap.
const BROWSER_ZONE = "America/New_York";

describe("LocalDateTime", () => {
  it("server-renders the deterministic UTC text (no hydration mismatch)", () => {
    expect(renderToString(<LocalDateTime value={ISO} />)).toBe(formatDateTime(ISO, "UTC"));
  });

  it("renders the browser time zone once mounted, not the UTC server snapshot", () => {
    const { container } = render(<LocalDateTime value={ISO} />);
    expect(container.textContent).toBe(formatDateTime(ISO, BROWSER_ZONE));
    expect(container.textContent).not.toBe(formatDateTime(ISO, "UTC"));
  });

  it("renders the year-bearing variant when withYear is set", () => {
    const { container } = render(<LocalDateTime value={ISO} withYear />);
    expect(container.textContent).toBe(formatDateTimeWithYear(ISO, BROWSER_ZONE));
  });
});

describe("useDisplayTimeZone", () => {
  it("reports UTC on the server and the browser zone on the client", () => {
    function ZoneProbe() {
      return <span data-testid="zone">{useDisplayTimeZone()}</span>;
    }

    expect(renderToString(<ZoneProbe />)).toContain("UTC");

    const { getByTestId } = render(<ZoneProbe />);
    expect(getByTestId("zone").textContent).toBe(BROWSER_ZONE);
  });
});
