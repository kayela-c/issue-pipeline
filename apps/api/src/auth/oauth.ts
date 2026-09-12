import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Gitea OAuth2 as a confidential client with PKCE.
 *
 * Gitea 1.25 silently widens a token to *all* scopes if any requested scope
 * name fails to parse, so SCOPES is a constant guarded by a unit test.
 */
export const SCOPES = "read:user read:organization read:repository write:issue";

const TOKEN_TIMEOUT_MS = 15_000;

export interface OAuthConfig {
  giteaBaseUrl: string;
  clientId: string;
  clientSecret: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function oauthConfigFromEnv(): OAuthConfig {
  return {
    giteaBaseUrl: requireEnv("GITEA_BASE_URL").replace(/\/+$/, ""),
    clientId: requireEnv("GITEA_OAUTH_CLIENT_ID"),
    clientSecret: requireEnv("GITEA_OAUTH_CLIENT_SECRET"),
  };
}

/** 32 random bytes, base64url: 43 characters, valid as a PKCE verifier. */
export const randomToken = () => randomBytes(32).toString("base64url");

export const codeChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

export function authorizeUrl(
  cfg: OAuthConfig,
  params: { redirectUri: string; state: string; codeChallenge: string },
): string {
  const url = new URL(`${cfg.giteaBaseUrl}/login/oauth/authorize`);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** The callback URI for a request's own origin. Each origin must be registered in Gitea. */
export const callbackUri = (req: Request) => `${new URL(req.url).origin}/api/auth/callback`;

/**
 * Only same-site relative paths survive; anything that could leave the site
 * (`//host`, `/\host`, absolute URLs) collapses to "/".
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || value.length > 2000) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  if (value.startsWith("/api/")) return "/";
  return value;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().default(""),
  expires_in: z.number().int().positive(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export type TokenResult =
  | { ok: true; token: TokenResponse }
  /** Gitea refused the grant: bad code, or a revoked/expired refresh token. */
  | { ok: false; kind: "rejected"; message: string }
  /** Network trouble or a Gitea outage; the session may still be fine. */
  | { ok: false; kind: "transport"; message: string };

type FetchLike = typeof fetch;

async function tokenRequest(
  cfg: OAuthConfig,
  form: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<TokenResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.giteaBaseUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        ...form,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, kind: "transport", message: err instanceof Error ? err.name : "network error" };
  }

  if (res.status >= 500 || res.status === 429) {
    return { ok: false, kind: "transport", message: `Gitea returned ${res.status}` };
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (res.ok) {
    const parsed = tokenResponseSchema.safeParse(body);
    return parsed.success
      ? { ok: true, token: parsed.data }
      : { ok: false, kind: "transport", message: "unexpected token response" };
  }
  const reason = z
    .object({ error: z.string().optional(), error_description: z.string().optional() })
    .safeParse(body);
  const message =
    (reason.success && (reason.data.error_description || reason.data.error)) ||
    `Gitea returned ${res.status}`;
  return { ok: false, kind: "rejected", message };
}

export function exchangeCode(
  cfg: OAuthConfig,
  params: { code: string; codeVerifier: string; redirectUri: string },
  fetchImpl: FetchLike = fetch,
): Promise<TokenResult> {
  return tokenRequest(
    cfg,
    {
      grant_type: "authorization_code",
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
    },
    fetchImpl,
  );
}

export function refreshTokens(
  cfg: OAuthConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenResult> {
  return tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}
