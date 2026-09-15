import { openCredential, sealCredential, type CredentialSlot } from "../crypto/credentials";
import { IdentityLinkedElsewhere } from "../db/identities";
import { githubAccessTokenSlot } from "../forge/forRepo";
import { redact } from "./withAuth";
import { redirect, type LoginDeps, type LoginError } from "./handlers";
import {
  githubAuthorizeUrl,
  githubCallbackUri,
  hasRepoScope,
  type GithubOAuthConfig,
  type GithubTokenResult,
  type GithubUserResult,
} from "./github";
import { randomToken, safeReturnTo } from "./oauth";
import {
  GITHUB_OAUTH_COOKIE,
  OAUTH_STATE_MAX_AGE_SECONDS,
  SESSION_COOKIE,
  clearCookieHeader,
  githubOauthStateSchema,
  readCookie,
  seal,
  sessionCookieHeader,
  sessionSchema,
  setCookieHeader,
  unseal,
  type GithubOAuthState,
  type Keyring,
  type Session,
} from "./session";

/** One linked identity, as far as sign-in needs to know. Null token: this account has no Gitea link yet. */
export interface StoredIdentity {
  userId: string;
  giteaRefreshTokenEnc: string | null;
}

/** The minimum an account needs to start a session. */
export interface AccountUser {
  id: string;
  username: string;
}

export interface GithubLoginDeps extends LoginDeps {
  githubConfig(): GithubOAuthConfig;
  /** GitHub logins allowed to sign in or link, lower-cased. */
  allowedGithubUsers(): Set<string>;
  exchangeGithub(cfg: GithubOAuthConfig, params: { code: string; redirectUri: string }): Promise<GithubTokenResult>;
  fetchGithubUser(accessToken: string): Promise<GithubUserResult>;
  /** CREDENTIALS_KEY, for the stored Gitea refresh token snapshot (src/crypto/credentials.ts). */
  credentialKeys(): Keyring;
  findGithubIdentity(forgeUserId: string): Promise<StoredIdentity | undefined>;
  /** Throws IdentityLinkedElsewhere if this GitHub account already links to a different user. */
  linkGithubIdentity(input: { userId: string; forgeUserId: string; username: string; giteaRefreshTokenEnc: string | null }): Promise<void>;
  touchGithubIdentityToken(userId: string, giteaRefreshTokenEnc: string): Promise<void>;
  /** Store the sealed GitHub access token for repo access (Phase 9), or null when the `repo` scope was not granted. */
  saveGithubAccessToken(userId: string, accessTokenEnc: string | null): Promise<void>;
  /** A brand-new account, created directly by GitHub sign-in with no Gitea link yet (decision 22). */
  createAccount(input: { username: string; displayName: string | null }): Promise<AccountUser>;
  getAccountUser(userId: string): Promise<AccountUser | undefined>;
}

const credentialSlot = (userId: string): CredentialSlot => ({
  column: "user_identities.gitea_refresh_token",
  userId,
  subject: "github",
});

/** A session for an account with no Gitea link at all -- signed in, but every Gitea-backed endpoint refuses it (withAuth). */
function giteaLessSession(user: AccountUser, now: number): Session {
  return {
    uid: user.id,
    username: user.username,
    gitea_id: null,
    access_token: null,
    refresh_token: null,
    access_expires_at: null,
    session_started_at: now,
  };
}

/** GET /api/auth/github/login -- start GitHub OAuth. Works both signed out (sign in) and signed in (link). */
export function handleGithubLogin(req: Request, deps: GithubLoginDeps): Response {
  const url = new URL(req.url);
  const state: GithubOAuthState = {
    state: randomToken(),
    return_to: safeReturnTo(url.searchParams.get("return_to")),
    created_at: deps.now(),
  };
  const cookie = setCookieHeader(
    GITHUB_OAUTH_COOKIE,
    seal(GITHUB_OAUTH_COOKIE, state, deps.keys()),
    OAUTH_STATE_MAX_AGE_SECONDS,
  );
  const location = githubAuthorizeUrl(deps.githubConfig(), {
    redirectUri: githubCallbackUri(req),
    state: state.state,
  });
  return redirect(location, [cookie]);
}

/**
 * GET /api/auth/github/callback -- finish GitHub OAuth.
 *
 * With a valid session cookie already present, this links the GitHub account
 * to the signed-in user. Without one, it signs in through a previously linked
 * account: the stored Gitea refresh token mints a fresh Gitea session, so the
 * org membership gate is re-checked exactly as a direct Gitea sign-in would.
 */
export async function handleGithubCallback(req: Request, deps: GithubLoginDeps): Promise<Response> {
  const url = new URL(req.url);
  const clearState = clearCookieHeader(GITHUB_OAUTH_COOKIE);
  const fail = (reason: LoginError) =>
    redirect(`/login?error=${reason}`, [clearState], { "referrer-policy": "no-referrer" });

  const keys = deps.keys();
  const pending = unseal(GITHUB_OAUTH_COOKIE, readCookie(req, GITHUB_OAUTH_COOKIE), keys, githubOauthStateSchema);
  const now = deps.now();
  if (!pending || now - pending.created_at > OAUTH_STATE_MAX_AGE_SECONDS) {
    return fail("github_expired");
  }
  if (url.searchParams.get("state") !== pending.state) {
    return fail("github_expired");
  }
  if (url.searchParams.get("error")) {
    return fail("github_denied");
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return fail("github_failed");
  }

  const session = unseal(SESSION_COOKIE, readCookie(req, SESSION_COOKIE), keys, sessionSchema);
  const sessionValid = session && now - session.session_started_at < deps.sessionMaxAgeSeconds();

  try {
    const cfg = deps.githubConfig();
    const tokenResult = await deps.exchangeGithub(cfg, { code, redirectUri: githubCallbackUri(req) });
    if (!tokenResult.ok) {
      console.error("github code exchange failed", { kind: tokenResult.kind, message: tokenResult.message });
      return fail(tokenResult.kind === "transport" ? "github_unavailable" : "github_failed");
    }

    const userResult = await deps.fetchGithubUser(tokenResult.accessToken);
    if (!userResult.ok) {
      console.error("github user fetch failed", { kind: userResult.kind, message: userResult.message });
      return fail(userResult.kind === "transport" ? "github_unavailable" : "github_failed");
    }
    const githubUser = userResult.user;

    if (!deps.allowedGithubUsers().has(githubUser.login.toLowerCase())) {
      return fail("github_not_allowed");
    }

    const credKeys = deps.credentialKeys();
    // Every successful sign-in or link refreshes the stored GitHub token, so repo access follows the latest grant.
    const saveAccessToken = (userId: string) =>
      deps.saveGithubAccessToken(
        userId,
        hasRepoScope(tokenResult.scopes) ? sealCredential(tokenResult.accessToken, githubAccessTokenSlot(userId), credKeys) : null,
      );

    if (sessionValid) {
      // Sealing null when the signed-in account has no Gitea link either (rare: re-connecting GitHub to an account it already created).
      const sealed = session.refresh_token ? sealCredential(session.refresh_token, credentialSlot(session.uid), credKeys) : null;
      try {
        await deps.linkGithubIdentity({
          userId: session.uid,
          forgeUserId: githubUser.id,
          username: githubUser.login,
          giteaRefreshTokenEnc: sealed,
        });
      } catch (err) {
        if (err instanceof IdentityLinkedElsewhere) return fail("github_already_linked");
        throw err;
      }
      await saveAccessToken(session.uid);
      return redirect(pending.return_to, [clearState], { "referrer-policy": "no-referrer" });
    }

    const identity = await deps.findGithubIdentity(githubUser.id);

    if (!identity) {
      // No account has ever linked this GitHub identity: create one, Gitea-less (decision 22).
      const user = await deps.createAccount({ username: githubUser.login, displayName: null });
      await deps.linkGithubIdentity({ userId: user.id, forgeUserId: githubUser.id, username: githubUser.login, giteaRefreshTokenEnc: null });
      await saveAccessToken(user.id);
      const sessionCookie = sessionCookieHeader(giteaLessSession(user, now), keys, deps.sessionMaxAgeSeconds(), now);
      return redirect(pending.return_to, [clearState, sessionCookie], { "referrer-policy": "no-referrer" });
    }

    if (!identity.giteaRefreshTokenEnc) {
      // This account exists but has never linked Gitea: sign it straight in, still Gitea-less.
      const user = await deps.getAccountUser(identity.userId);
      if (!user) return fail("github_unavailable");
      await saveAccessToken(user.id);
      const sessionCookie = sessionCookieHeader(giteaLessSession(user, now), keys, deps.sessionMaxAgeSeconds(), now);
      return redirect(pending.return_to, [clearState, sessionCookie], { "referrer-policy": "no-referrer" });
    }

    const refreshToken = openCredential(identity.giteaRefreshTokenEnc, credentialSlot(identity.userId), credKeys);
    if (!refreshToken) return fail("github_link_expired");

    const refreshed = await deps.refresh(deps.oauth(), refreshToken);
    if (!refreshed.ok) {
      if (refreshed.kind === "rejected") return fail("github_link_expired");
      console.error("github-linked gitea refresh failed", { message: refreshed.message });
      return fail("unavailable");
    }

    const forge = deps.createForge(refreshed.token.access_token);
    const forgeUser = await forge.getCurrentUser();
    if (!(await forge.isOrgMember(deps.allowedOrg(), forgeUser.username))) {
      return fail("not_member");
    }
    const user = await deps.upsertUser(forgeUser);

    const newSession: Session = {
      uid: user.id,
      gitea_id: forgeUser.id,
      username: forgeUser.username,
      access_token: refreshed.token.access_token,
      refresh_token: refreshed.token.refresh_token,
      access_expires_at: now + refreshed.token.expires_in,
      session_started_at: now,
    };
    // Gitea rotates the refresh token on every use; keep the stored snapshot current for next time.
    await deps.touchGithubIdentityToken(user.id, sealCredential(refreshed.token.refresh_token, credentialSlot(user.id), credKeys));
    await saveAccessToken(user.id);

    const sessionCookie = sessionCookieHeader(newSession, keys, deps.sessionMaxAgeSeconds(), now);
    return redirect(pending.return_to, [clearState, sessionCookie], { "referrer-policy": "no-referrer" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("github oauth callback failed", { message: redact(message) });
    return fail("github_unavailable");
  }
}
