import { z } from "zod";

/**
 * GitHub OAuth App: sign-in identity (Phase 8) and, since Phase 9, access to
 * the user's repositories (docs/ARCHITECTURE.md section 5, decision 23).
 * `repo` is broad -- full read and write to every repo the user can reach --
 * but it is what an OAuth App needs for private repos; a GitHub App would be
 * narrower and was deliberately not chosen.
 */
export const GITHUB_SCOPE = "read:user repo";

/** Whether a token response granted repository access. */
export const hasRepoScope = (scopes: readonly string[]) => scopes.includes("repo");

const TOKEN_TIMEOUT_MS = 15_000;
const USER_AGENT = "issue-pipeline";

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function githubOAuthConfigFromEnv(): GithubOAuthConfig {
  return {
    clientId: requireEnv("GITHUB_OAUTH_CLIENT_ID"),
    clientSecret: requireEnv("GITHUB_OAUTH_CLIENT_SECRET"),
  };
}

/** GitHub usernames allowed to sign in or link, from a comma-separated env var. Empty means nobody. */
export function githubAllowedUsersFromEnv(): Set<string> {
  const raw = process.env.GITHUB_ALLOWED_USERS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** The callback URI for a request's own origin, mirroring oauth.ts's callbackUri for Gitea. */
export const githubCallbackUri = (req: Request) => `${new URL(req.url).origin}/api/auth/github/callback`;

export function githubAuthorizeUrl(cfg: GithubOAuthConfig, params: { redirectUri: string; state: string }): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", GITHUB_SCOPE);
  url.searchParams.set("state", params.state);
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

const tokenResponseSchema = z.object({ access_token: z.string().min(1), scope: z.string().default("") });

export type GithubTokenResult =
  /** `scopes`: what the user actually granted (comma-separated in GitHub's response). */
  | { ok: true; accessToken: string; scopes: string[] }
  /** GitHub refused the grant: bad code, expired, already used. */
  | { ok: false; kind: "rejected"; message: string }
  /** Network trouble or a GitHub outage. */
  | { ok: false; kind: "transport"; message: string };

type FetchLike = typeof fetch;

export async function exchangeGithubCode(
  cfg: GithubOAuthConfig,
  params: { code: string; redirectUri: string },
  fetchImpl: FetchLike = fetch,
): Promise<GithubTokenResult> {
  let res: Response;
  try {
    res = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code: params.code,
        redirect_uri: params.redirectUri,
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, kind: "transport", message: err instanceof Error ? err.name : "network error" };
  }

  if (res.status >= 500 || res.status === 429) {
    return { ok: false, kind: "transport", message: `GitHub returned ${res.status}` };
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (res.ok) {
    // GitHub answers 200 even for a rejected grant, with an `error` field instead of a token.
    const parsed = tokenResponseSchema.safeParse(body);
    if (parsed.success) {
      const scopes = parsed.data.scope.split(/[\s,]+/).filter(Boolean);
      return { ok: true, accessToken: parsed.data.access_token, scopes };
    }
    const reason = z.object({ error: z.string().optional(), error_description: z.string().optional() }).safeParse(body);
    return {
      ok: false,
      kind: "rejected",
      message: (reason.success && (reason.data.error_description || reason.data.error)) || "unexpected token response",
    };
  }
  return { ok: false, kind: "rejected", message: `GitHub returned ${res.status}` };
}

export interface GithubUser {
  id: string;
  login: string;
}

export type GithubUserResult =
  | { ok: true; user: GithubUser }
  | { ok: false; kind: "rejected"; message: string }
  | { ok: false; kind: "transport"; message: string };

const githubUserResponseSchema = z.object({ id: z.number().int(), login: z.string().min(1) });

export async function fetchGithubUser(accessToken: string, fetchImpl: FetchLike = fetch): Promise<GithubUserResult> {
  let res: Response;
  try {
    res = await fetchImpl("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, kind: "transport", message: err instanceof Error ? err.name : "network error" };
  }
  if (res.status >= 500 || res.status === 429) {
    return { ok: false, kind: "transport", message: `GitHub returned ${res.status}` };
  }
  if (!res.ok) {
    return { ok: false, kind: "rejected", message: `GitHub returned ${res.status}` };
  }
  const parsed = githubUserResponseSchema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) return { ok: false, kind: "transport", message: "unexpected user response" };
  return { ok: true, user: { id: String(parsed.data.id), login: parsed.data.login } };
}
