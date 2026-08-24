import { describe, expect, it, vi } from "vitest";

import { readLaunchGrantUsd } from "@/lib/billing/launch-grant";

/** Chainable credit_ledger read resolving to `result` at `.in()`. */
function supabaseWithLedger(result: { data: unknown; error: { message: string } | null }) {
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn().mockResolvedValue(result)
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return { from: vi.fn().mockReturnValue(chain), chain };
}

type Client = Parameters<typeof readLaunchGrantUsd>[0];

describe("readLaunchGrantUsd", () => {
  it("sums launch grants and the YC promo-fold reversal, nothing else", async () => {
    const { from } = supabaseWithLedger({
      data: [
        { entry_type: "grant", amount_usd: 20, source_ref: null },
        { entry_type: "grant", amount_usd: 526, source_ref: null },
        // The promo fold claws the standard grant back on a YC claim.
        { entry_type: "adjustment", amount_usd: -20, source_ref: "promo-reversal:abc" },
        // An expiry adjustment is NOT part of the announced grant event.
        { entry_type: "adjustment", amount_usd: -5, source_ref: "expiry:xyz" }
      ],
      error: null
    });

    expect(await readLaunchGrantUsd({ from } as unknown as Client, "org-1")).toBe(526);
  });

  it("skips malformed amounts instead of poisoning the total", async () => {
    const { from } = supabaseWithLedger({
      data: [
        { entry_type: "grant", amount_usd: 20, source_ref: null },
        { entry_type: "grant", amount_usd: "garbage", source_ref: null }
      ],
      error: null
    });

    expect(await readLaunchGrantUsd({ from } as unknown as Client, "org-1")).toBe(20);
  });

  it("returns null when the ledger read fails", async () => {
    const { from } = supabaseWithLedger({ data: null, error: { message: "boom" } });

    expect(await readLaunchGrantUsd({ from } as unknown as Client, "org-1")).toBeNull();
  });
});
