"use client";

// Client mutation helpers for the identity-tier surface. Reads are fetched
// server-side and passed in as props (the settings/members pattern); these
// wrap the Next BFF mutation routes, and the panel calls router.refresh()
// after a success so the server props re-render. Each returns the parsed body
// or throws an Error carrying the backend message.

import type { BudgetView, IdentityView, SetBudgetInput } from "@/lib/identities/types";

async function mutate<T>(input: string, init: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: init.body === undefined ? init.headers : { "content-type": "application/json" }
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(
      typeof payload?.error === "string" ? payload.error : `The request failed (${response.status}).`
    );
  }
  const text = await response.text();
  return (text.length === 0 ? null : JSON.parse(text)) as T;
}

const orgBase = (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}`;

export function createIdentity(
  orgId: string,
  body: { display_name: string; description?: string | null }
): Promise<IdentityView> {
  return mutate<IdentityView>(`${orgBase(orgId)}/identities`, {
    body: JSON.stringify(body),
    method: "POST"
  });
}

export function renameIdentity(
  orgId: string,
  identityId: string,
  body: { display_name?: string; description?: string | null; active?: boolean }
): Promise<IdentityView> {
  return mutate<IdentityView>(
    `${orgBase(orgId)}/identities/${encodeURIComponent(identityId)}`,
    { body: JSON.stringify(body), method: "PATCH" }
  );
}

export function disableIdentity(orgId: string, identityId: string): Promise<IdentityView> {
  return mutate<IdentityView>(`${orgBase(orgId)}/identities/${encodeURIComponent(identityId)}`, {
    method: "DELETE"
  });
}

export function setGrant(
  orgId: string,
  identityId: string,
  aliasId: string,
  granted: boolean
): Promise<{ granted: boolean; changed: boolean }> {
  return mutate<{ granted: boolean; changed: boolean }>(
    `${orgBase(orgId)}/identities/${encodeURIComponent(identityId)}/grants/${encodeURIComponent(aliasId)}`,
    { method: granted ? "PUT" : "DELETE" }
  );
}

export function setBudget(orgId: string, body: SetBudgetInput): Promise<BudgetView> {
  return mutate<BudgetView>(`${orgBase(orgId)}/budgets`, {
    body: JSON.stringify(body),
    method: "PUT"
  });
}

export function deleteBudget(orgId: string, budgetId: string): Promise<{ deleted: boolean }> {
  return mutate<{ deleted: boolean }>(
    `${orgBase(orgId)}/budgets/${encodeURIComponent(budgetId)}`,
    { method: "DELETE" }
  );
}
