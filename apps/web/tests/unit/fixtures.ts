import type { Org } from "@/lib/types";

export function makeOrg(overrides: Partial<Org> = {}): Org {
  return {
    id: "org1",
    slug: "demo",
    name: "Demo",
    role: "admin",
    spend_usd: 0,
    billable_spend_usd: 0,
    credit_granted_usd: 20,
    credit_balance_usd: 20,
    ...overrides
  };
}
export function sseBody(events: readonly unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}