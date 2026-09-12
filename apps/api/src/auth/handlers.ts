import { apiError } from "../http";
import { passesCsrfCheck } from "./csrf";
import {
  authorizeUrl,
  callbackUri,
  codeChallenge,
  randomToken,
  safeReturnTo,
  type OAuthConfig,
  type TokenResult,
} from "./oauth";
import { redact, type AuthDeps } from "./withAuth";
import {
  OAUTH_COOKIE,
  OAUTH_STATE_MAX_AGE_SECONDS,
  SESSION_COOKIE,
  clearCookieHeader,
  oauthStateSchema,
  readCookie,
  seal,
  sessionCookieHeader,
  setCookieHeader,
  unseal,
  type OAuthState,
  type Session,
} from "./session";

export interface LoginDeps extends AuthDeps {
  exchange(
    cfg: OAuthConfig,
    params: { code: string; codeVerifier: string; redirectUri: string },
  ): Promise<TokenResult>;
}

/** Reasons the login screen knows how to explain. */
export type LoginError = "denied" | "not_member" | "expired" | "failed" | "unavailable";

const NO_STORE = { "cache-control": "no-store" };

function redirect(location: string, cookies: string[], extraHeaders: Record<string, string> = {}): Response {
  const headers = new Headers({ location, ...NO_STORE, ...extraHeaders });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

/** GET /api/auth/login -- start the OAuth flow. */
export function handleLogin(req: Request, deps: LoginDeps): Response {
  const url = new URL(req.url);
  const verifier = randomToken();
  const state: OAuthState = {
    state: randomToken(),
    code_verifier: verifier,
    return_to: safeReturnTo(url.searchParams.get("return_to")),
    created_at: deps.now(),
  };
  const cookie = setCookieHeader(
    OAUTH_COOKIE,
    seal(OAUTH_COOKIE, state, deps.keys()),
    OAUTH_STATE_MAX_AGE_SECONDS,
  );
  const location = authorizeUrl(deps.oauth(), {
    redirectUri: callbackUri(req),
    state: state.state,
    codeChallenge: codeChallenge(verifier),
  });
  return redirect(location, [cookie]);
}

/** GET /api/auth/callback -- finish the OAuth flow and start a session. */
export async function handleCallback(req: Request, deps: LoginDeps): Promise<Response> {
  const url = new URL(req.url);
  const clearState = clearCookieHeader(OAUTH_COOKIE);
  // The callback URL carries the authorization code: keep it out of Referer.
  const fail = (reason: LoginError) =>
    redirect(`/login?error=${reason}`, [clearState], { "referrer-policy": "no-referrer" });

  const keys = deps.keys();
  const pending = unseal(OAUTH_COOKIE, readCookie(req, OAUTH_COOKIE), keys, oauthStateSchema);
  const now = deps.now();
  if (!pending || now - pending.created_at > OAUTH_STATE_MAX_AGE_SECONDS) {
    return fail("expired");
  }
  if (url.searchParams.get("state") !== pending.state) {
    return fail("expired");
  }
  if (url.searchParams.get("error")) {
    return fail("denied");
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return fail("failed");
  }

  let accessToken: string | undefined;
  try {
    const cfg = deps.oauth();
    const result = await deps.exchange(cfg, {
      code,
      codeVerifier: pending.code_verifier,
      redirectUri: callbackUri(req),
    });
    if (!result.ok) {
      console.error("oauth code exchange failed", { kind: result.kind, message: result.message });
      return fail(result.kind === "transport" ? "unavailable" : "failed");
    }
    accessToken = result.token.access_token;

    const forge = deps.createForge(accessToken);
    const forgeUser = await forge.getCurrentUser();
    if (!(await forge.isOrgMember(deps.allowedOrg(), forgeUser.username))) {
      return fail("not_member");
    }
    const user = await deps.upsertUser(forgeUser);

    const session: Session = {
      uid: user.id,
      gitea_id: forgeUser.id,
      username: forgeUser.username,
      access_token: result.token.access_token,
      refresh_token: result.token.refresh_token,
      access_expires_at: now + result.token.expires_in,
      session_started_at: now,
    };
    const sessionCookie = sessionCookieHeader(session, keys, deps.sessionMaxAgeSeconds(), now);
    return redirect(pending.return_to, [clearState, sessionCookie], { "referrer-policy": "no-referrer" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("oauth callback failed", { message: redact(message, accessToken, code) });
    return fail("unavailable");
  }
}

/** POST /api/auth/logout -- end the session. Idempotent. */
export function handleLogout(req: Request): Response {
  if (!passesCsrfCheck(req)) {
    return apiError("forbidden", "Cross-site request rejected.");
  }
  const headers = new Headers(NO_STORE);
  headers.append("set-cookie", clearCookieHeader(SESSION_COOKIE));
  return new Response(null, { status: 204, headers });
}
