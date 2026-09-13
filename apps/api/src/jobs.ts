import { timingSafeEqual, createHash } from "node:crypto";

const SECRET_HEADER = "x-internal-secret";

function jobSecret(): string {
  const secret = process.env.INTERNAL_JOB_SECRET;
  if (!secret) throw new Error("INTERNAL_JOB_SECRET is not set");
  return secret;
}

/** Constant-time check of the shared secret on /internal/* requests. */
export function hasValidJobSecret(req: Request): boolean {
  const given = req.headers.get(SECRET_HEADER);
  if (!given) return false;
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(jobSecret()).digest();
  return timingSafeEqual(a, b);
}

/**
 * Start a background job on this site. Background functions answer 202 as
 * soon as they are accepted, so this returns quickly. The caller's current
 * Gitea token is forwarded server-to-server so the job acts as that user.
 */
export async function triggerJob(
  req: Request,
  path: `/internal/${string}`,
  body: Record<string, string>,
  giteaToken: string,
): Promise<boolean> {
  // The request's own origin is this site (production, preview, or netlify dev).
  const url = `${new URL(req.url).origin}${path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SECRET_HEADER]: jobSecret(),
        authorization: `Bearer ${giteaToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 202) {
      console.error("job trigger rejected", { path, status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    console.error("job trigger failed", { path, message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
