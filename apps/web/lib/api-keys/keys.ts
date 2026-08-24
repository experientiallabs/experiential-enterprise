import { createHash, randomBytes } from "node:crypto";

import { API_KEY_EXPIRY_DAYS } from "./types";

// Customer API keys: `xpl_` + 40 hex chars (160 random bits). Only the
// SHA-256 hash is persisted; the plaintext is shown once at mint time.
const API_KEY_SECRET_PREFIX = "xpl_";

// How much of the plaintext the UI keeps for recognition (e.g. `xpl_ab12cd34`).
const KEY_PREFIX_LENGTH = 12;

// The stored display tail (last-4 practice): with the prefix, key rows render
// `xpl_ab12cd34…f2e1`, disclosing 12 of the 40 random hex digits and leaving
// 112 random bits hidden.
const KEY_SUFFIX_LENGTH = 4;

type MintedApiKey = {
  secret: string;
  keyPrefix: string;
  keySuffix: string;
  keyHash: string;
};

/**
 * The ONE secret recipe every credential class shares: 160 random bits after
 * the class prefix, SHA-256 hex digest for storage, a short display prefix
 * plus a last-4 display suffix. The Python side verifies both classes through
 * one hash_api_key, so minting must have exactly one implementation too — a
 * digest/entropy change edits this function and nothing else. Consumers:
 * customer keys (below) and superadmin keys (lib/admin/superadmin-keys.ts).
 */
export function mintKeySecret(prefix: string, prefixLength: number): MintedApiKey {
  const secret = `${prefix}${randomBytes(20).toString("hex")}`;
  return {
    secret,
    keyPrefix: secret.slice(0, prefixLength),
    keySuffix: secret.slice(-KEY_SUFFIX_LENGTH),
    keyHash: createHash("sha256").update(secret).digest("hex")
  };
}

export function mintApiKeySecret(): MintedApiKey {
  return mintKeySecret(API_KEY_SECRET_PREFIX, KEY_PREFIX_LENGTH);
}

export type CreateApiKeyPayload = {
  orgId: string;
  name: string;
  // Days until the key stops authenticating; null mints a non-expiring key.
  expiresInDays: number | null;
  // The identity to hang the key off. Null lets the mint route resolve the
  // org's default identity, preserving the pre-identity-tier behavior of the
  // org-level "API keys" panel.
  identityId: string | null;
};

export function parseCreateApiKeyPayload(value: unknown): CreateApiKeyPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("API key request must be an object.");
  }
  const payload = value as Record<string, unknown>;
  const orgId = payload.orgId;
  const name = payload.name;
  const expiresInDays = payload.expiresInDays ?? null;
  const identityId = payload.identityId ?? null;
  if (typeof orgId !== "string" || orgId.trim().length === 0) {
    throw new Error("API key request must include an orgId.");
  }
  if (typeof name !== "string" || name.trim().length === 0 || name.trim().length > 80) {
    throw new Error("API key name must be 1-80 characters.");
  }
  // The offered durations are the product contract; the API refuses anything
  // the key lifecycle UI does not advertise.
  if (
    expiresInDays !== null &&
    (typeof expiresInDays !== "number" ||
      !API_KEY_EXPIRY_DAYS.includes(expiresInDays as (typeof API_KEY_EXPIRY_DAYS)[number]))
  ) {
    throw new Error(`API key expiry must be one of ${API_KEY_EXPIRY_DAYS.join(", ")} days.`);
  }
  if (identityId !== null && (typeof identityId !== "string" || identityId.trim().length === 0)) {
    throw new Error("API key identityId must be a non-empty string when provided.");
  }
  return {
    orgId: orgId.trim(),
    name: name.trim(),
    expiresInDays,
    identityId: identityId === null ? null : (identityId as string).trim()
  };
}

export function expiryTimestamp(expiresInDays: number | null): string | null {
  if (expiresInDays === null) {
    return null;
  }
  return new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
}
