import { z } from "zod";
import { decrypt, encrypt, keyringFromEnvVars, type Keyring } from "../crypto/aead";

/**
 * Stateless sessions: the session lives in an AES-256-GCM encrypted,
 * HttpOnly cookie, so Gitea tokens are never readable by browser JavaScript
 * and never stored in Postgres. See docs/ARCHITECTURE.md section 5.
 */

export const SESSION_COOKIE = "__Host-ip_session";
export const OAUTH_COOKIE = "__Host-ip_oauth";
export const GITHUB_OAUTH_COOKIE = "__Host-ip_github_oauth";

/** Login-state cookie lifetime: long enough to sign in, short enough to go stale. */
export const OAUTH_STATE_MAX_AGE_SECONDS = 600;

/**
 * Gitea fields are null for an account created by a non-Gitea sign-in that
 * has not connected Gitea yet (decision 22) -- such a session cannot use any
 * endpoint that needs Gitea (withAuth refuses those with `gitea_required`),
 * but can still sign in, see /api/me, and connect Gitea.
 */
export const sessionSchema = z.object({
  uid: z.uuid(),
  username: z.string().min(1),
  gitea_id: z.number().int().nullable(),
  access_token: z.string().min(1).nullable(),
  refresh_token: z.string().nullable(),
  /** Unix seconds. */
  access_expires_at: z.number().int().nullable(),
  /** Unix seconds; the absolute session lifetime counts from here. */
  session_started_at: z.number().int(),
});
export type Session = z.infer<typeof sessionSchema>;

/** A session with a working Gitea link -- the shape withAuth's Gitea calls need. */
export type GiteaSession = Session & { gitea_id: number; access_token: string; refresh_token: string; access_expires_at: number };

export const hasGitea = (session: Session): session is GiteaSession => session.gitea_id !== null;

export const oauthStateSchema = z.object({
  state: z.string().min(1),
  code_verifier: z.string().min(43),
  return_to: z.string(),
  created_at: z.number().int(),
});
export type OAuthState = z.infer<typeof oauthStateSchema>;

/**
 * GitHub is a confidential client (client_secret stays server-side on the
 * token exchange), so this carries no PKCE verifier -- just enough to check
 * the callback matches a login this server started.
 */
export const githubOauthStateSchema = z.object({
  state: z.string().min(1),
  return_to: z.string(),
  created_at: z.number().int(),
});
export type GithubOAuthState = z.infer<typeof githubOauthStateSchema>;

export type { Keyring };

export function keyringFromEnv(): Keyring {
  return keyringFromEnvVars("SESSION_SECRET");
}

export function sessionMaxAgeSecondsFromEnv(): number {
  const days = Number(process.env.SESSION_MAX_AGE_DAYS ?? "7");
  return Math.round((Number.isFinite(days) && days > 0 ? days : 7) * 86_400);
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Encrypt a payload for the named cookie. The cookie name is authenticated
 * data, so a value sealed for one cookie cannot be replayed as the other.
 */
export function seal(cookieName: string, payload: unknown, keys: Keyring): string {
  return encrypt(JSON.stringify(payload), cookieName, keys);
}

/** Decrypt and validate; `undefined` for anything tampered, stale-keyed, or malformed. */
export function unseal<T>(
  cookieName: string,
  value: string | undefined,
  keys: Keyring,
  schema: z.ZodType<T>,
): T | undefined {
  const plaintext = decrypt(value, cookieName, keys);
  if (plaintext === undefined) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(plaintext));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// --- Cookie headers ------------------------------------------------------------

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return undefined;
}

/**
 * `__Host-` cookies must be Secure, Path=/, and carry no Domain. Browsers
 * accept Secure cookies on http://localhost, so this also works in dev.
 */
export function setCookieHeader(name: string, value: string, maxAgeSeconds: number): string {
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookieHeader(name: string): string {
  return setCookieHeader(name, "", 0);
}

export function sessionCookieHeader(session: Session, keys: Keyring, maxAgeSeconds: number, now: number): string {
  const remaining = session.session_started_at + maxAgeSeconds - now;
  return setCookieHeader(SESSION_COOKIE, seal(SESSION_COOKIE, session, keys), remaining);
}

/** Copy a response with extra Set-Cookie headers (handler responses may be immutable). */
export function withCookies(res: Response, cookies: string[]): Response {
  if (cookies.length === 0) return res;
  const headers = new Headers(res.headers);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
