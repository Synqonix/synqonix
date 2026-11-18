/** Only allow same-site relative redirects (prevents open redirects via `?next=`). */
export function safeNext(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw || !raw.startsWith("/")) return fallback;
  // Browsers drop tabs and newlines inside a URL and treat backslashes as slashes, so "/<tab>/host"
  // is really "//host". Control characters have no place in a path, and backslashes are refused too.
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
  try {
    // Resolve against a fixed origin: anything that lands elsewhere is not a same-site path.
    const base = "http://same-site.invalid";
    const url = new URL(raw, base);
    if (url.origin !== base) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
