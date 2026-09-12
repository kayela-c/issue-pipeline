const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF check for cookie-authenticated requests.
 *
 * Browsers attach the session cookie to any request aimed at this site, so a
 * state-changing request must prove it came from this site's own pages: the
 * `Origin` header must equal the request's origin, `Sec-Fetch-Site` (when
 * sent) must be same-origin, and a body must be JSON -- a content type that a
 * cross-site form cannot send without a CORS preflight, which this API never
 * grants.
 */
export function passesCsrfCheck(req: Request): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;

  const origin = req.headers.get("origin");
  if (!origin || origin !== new URL(req.url).origin) return false;

  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;

  if (req.body !== null) {
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) return false;
  }
  return true;
}
