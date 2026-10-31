/** Diagnostic URLs must never include userinfo, query credentials, or fragments. */
export function displayUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "redis:", "rediss:"].includes(url.protocol)) return "[invalid URL]";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid URL]";
  }
}
