// Rebuild the query string a legacy UUID URL carried so its permanent
// redirect preserves state like ?rollout= deep links and ?page= pagination.
export function legacyQueryString(
  searchParams: Record<string, string | string[] | undefined>
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") {
      query.append(key, value);
    } else if (Array.isArray(value)) {
      value.forEach((entry) => query.append(key, entry));
    }
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}
