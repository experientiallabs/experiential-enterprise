// Resolve the public web origin the CLIENT actually used, so a self-hosted or
// local stack names its own dashboard host instead of the hosted default. The
// /llms.txt route and the /docs setup-prompts page derive it identically, so
// pasted prompts never mix a local API origin with the hosted web origin.

/** First entry of a possibly comma-chained forwarded header, trimmed. */
function firstForwardedValue(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  // x-forwarded-* can be a chain ("host1, host2") when several proxies each
  // append; the client-facing value is the first hop, so concatenating the
  // whole chain would yield an invalid origin.
  const first = raw.split(",")[0]?.trim();
  return first ? first : null;
}

/** The forwarded (proxy) or plain host, as `<proto>://<host>`; null with no host. */
export function webBaseUrlFromHeaders(source: {
  get(name: string): string | null;
}): string | undefined {
  const host = firstForwardedValue(source.get("x-forwarded-host")) ?? source.get("host");
  if (!host) {
    return undefined;
  }
  const proto = firstForwardedValue(source.get("x-forwarded-proto")) ?? "http";
  return `${proto}://${host}`;
}
