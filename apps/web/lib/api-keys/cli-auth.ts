// Helpers for the /cli/auth approval page. `wmh login` opens that page with a
// loopback port and an opaque state nonce; after the user approves, the page
// hands the freshly minted key back to the CLI by navigating to
// http://127.0.0.1:{port}/callback. Keeping the URL construction here (and
// loopback-only) means the page can never be turned into an open redirect.

// Non-system ports only; the CLI binds an ephemeral loopback listener.
const MIN_PORT = 1024;
const MAX_PORT = 65535;

// The CLI sends ~32 url-safe chars; anything much longer is not ours.
const MAX_STATE_LENGTH = 128;

export function parseLoopbackPort(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d{1,5}$/.test(raw)) {
    return null;
  }
  const port = Number(raw);
  return port >= MIN_PORT && port <= MAX_PORT ? port : null;
}

export function parseState(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  const state = raw.trim();
  if (state.length === 0 || state.length > MAX_STATE_LENGTH) {
    return null;
  }
  // The nonce round-trips inside a URL the CLI compares byte-for-byte;
  // reject anything outside the token_urlsafe alphabet.
  return /^[A-Za-z0-9_-]+$/.test(state) ? state : null;
}

export function buildLoopbackCallbackUrl(port: number, token: string, state: string): string {
  const url = new URL(`http://127.0.0.1:${port}/callback`);
  url.searchParams.set("token", token);
  url.searchParams.set("state", state);
  return url.toString();
}

export function suggestedKeyName(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim().slice(0, 80);
  return trimmed.length > 0 ? trimmed : "wmo CLI";
}
