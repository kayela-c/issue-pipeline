import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { openCredential, sealCredential } from "../crypto/credentials";
import { IdentityLinkedElsewhere } from "../db/identities";
import { githubAccessTokenSlot } from "../forge/forRepo";
import type { User } from "../db/users";
import { fakeForge } from "../forge/fake";
import type { ForgeClient } from "../forge/types";
import type { GithubTokenResult, GithubUserResult } from "./github";
import { handleGithubCallback, handleGithubLogin, type GithubLoginDeps, type StoredIdentity } from "./githubHandlers";
import type { TokenResult } from "./oauth";
import {
  GITHUB_OAUTH_COOKIE,
  SESSION_COOKIE,
  githubOauthStateSchema,
  seal,
  sessionSchema,
  unseal,
  type GithubOAuthState,
  type Keyring,
  type Session,
} from "./session";

const NOW = 1_800_000_000;
const ORIGIN = "http://localhost:8888";
const keys: Keyring = { current: randomBytes(32) };
const credKeys: Keyring = { current: randomBytes(32) };

const user: User = {
  id: "00000000-0000-4000-8000-000000000001",
  giteaId: 7,
  username: "kayela",
  displayName: null,
  createdAt: new Date(),
  lastSeenAt: new Date(),
};

const signedInSession: Session = {
  uid: user.id,
  gitea_id: 7,
  username: "kayela",
  access_token: "access",
  refresh_token: "refresh-current",
  access_expires_at: NOW + 3600,
  session_started_at: NOW - 10,
};

/** A signed-in account with no Gitea link at all (decision 22, created directly by GitHub). */
const giteaLessSession: Session = {
  uid: "00000000-0000-4000-8000-000000000003",
  username: "kayela-c",
  gitea_id: null,
  access_token: null,
  refresh_token: null,
  access_expires_at: null,
  session_started_at: NOW - 10,
};

const newUser = { id: "00000000-0000-4000-8000-000000000004", username: "kayela-c" };

const githubUser = { id: "42", login: "kayela-c" };

function makeDeps(
  opts: {
    member?: boolean;
    allowed?: string[];
    tokenResult?: GithubTokenResult;
    userResult?: GithubUserResult;
    identity?: StoredIdentity;
    refreshResult?: TokenResult;
    linkError?: unknown;
  } = {},
) {
  return {
    createForge: (): ForgeClient =>
      fakeForge({
        getCurrentUser: async () => ({ id: 7, username: "kayela" }),
        isOrgMember: async () => opts.member ?? true,
      }),
    upsertUser: vi.fn(async () => user),
    allowedOrg: () => "TrueRoster",
    keys: () => keys,
    oauth: () => ({ giteaBaseUrl: "https://git.example.com", clientId: "id", clientSecret: "secret" }),
    refresh: vi.fn(
      async (): Promise<TokenResult> =>
        opts.refreshResult ?? { ok: true, token: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 } },
    ),
    sessionMaxAgeSeconds: () => 7 * 86_400,
    now: () => NOW,
    exchange: vi.fn(),
    linkGitea: vi.fn(),
    githubConfig: () => ({ clientId: "gh-id", clientSecret: "gh-secret" }),
    allowedGithubUsers: () => new Set(opts.allowed ?? ["kayela-c"]),
    exchangeGithub: vi.fn(
      async (): Promise<GithubTokenResult> => opts.tokenResult ?? { ok: true, accessToken: "gho_token", scopes: ["read:user", "repo"] },
    ),
    fetchGithubUser: vi.fn(async (): Promise<GithubUserResult> => opts.userResult ?? { ok: true, user: githubUser }),
    credentialKeys: () => credKeys,
    findGithubIdentity: vi.fn(async () => opts.identity),
    linkGithubIdentity: vi.fn(async (_input: { userId: string; forgeUserId: string; username: string; giteaRefreshTokenEnc: string | null }) => {
      if (opts.linkError) throw opts.linkError;
    }),
    touchGithubIdentityToken: vi.fn(),
    saveGithubAccessToken: vi.fn(async (_userId: string, _enc: string | null) => {}),
    createAccount: vi.fn(async () => newUser),
    getAccountUser: vi.fn(async () => newUser),
  } satisfies GithubLoginDeps;
}

const cookieValue = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0]
    ?.slice(name.length + 1);

const pending: GithubOAuthState = { state: "state-123", return_to: "/settings/connections", created_at: NOW - 30 };

function callback(query: string, opts: { state?: GithubOAuthState | null; session?: Session | null } = {}) {
  const cookies: string[] = [];
  const state = opts.state === undefined ? pending : opts.state;
  if (state) cookies.push(`${GITHUB_OAUTH_COOKIE}=${seal(GITHUB_OAUTH_COOKIE, state, keys)}`);
  if (opts.session) cookies.push(`${SESSION_COOKIE}=${seal(SESSION_COOKIE, opts.session, keys)}`);
  return new Request(`${ORIGIN}/api/auth/github/callback?${query}`, { headers: { cookie: cookies.join("; ") } });
}

describe("handleGithubLogin", () => {
  it("redirects to GitHub with read:user and repo and stores state in an encrypted cookie", () => {
    const res = handleGithubLogin(new Request(`${ORIGIN}/api/auth/github/login?return_to=%2Fsettings%2Fconnections`), makeDeps());
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location")!);
    expect(location.hostname).toBe("github.com");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/github/callback`);
    expect(location.searchParams.get("scope")).toBe("read:user repo");

    const state = unseal(GITHUB_OAUTH_COOKIE, cookieValue(res, GITHUB_OAUTH_COOKIE), keys, githubOauthStateSchema)!;
    expect(state.return_to).toBe("/settings/connections");
    expect(location.searchParams.get("state")).toBe(state.state);
  });
});

describe("handleGithubCallback -- link mode (signed in already)", () => {
  it("links the GitHub account, storing the current Gitea refresh token", async () => {
    const deps = makeDeps();
    const res = await handleGithubCallback(callback("code=abc&state=state-123", { session: signedInSession }), deps);

    expect(res.headers.get("location")).toBe("/settings/connections");
    expect(deps.linkGithubIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user.id, forgeUserId: "42", username: "kayela-c" }),
    );
    const call = deps.linkGithubIdentity.mock.calls[0]![0];
    // The stored ciphertext decrypts back to the session's current refresh token.
    expect(call.giteaRefreshTokenEnc).not.toContain("refresh-current");
    expect(cookieValue(res, GITHUB_OAUTH_COOKIE)).toBe("");
  });

  it("refuses a GitHub account not on the allow-list", async () => {
    const deps = makeDeps({ allowed: ["someone-else"] });
    const res = await handleGithubCallback(callback("code=abc&state=state-123", { session: signedInSession }), deps);
    expect(res.headers.get("location")).toBe("/login?error=github_not_allowed");
    expect(deps.linkGithubIdentity).not.toHaveBeenCalled();
  });

  it("reports a GitHub account already linked to someone else", async () => {
    const deps = makeDeps({ linkError: new IdentityLinkedElsewhere("github") });
    const res = await handleGithubCallback(callback("code=abc&state=state-123", { session: signedInSession }), deps);
    expect(res.headers.get("location")).toBe("/login?error=github_already_linked");
  });

  it("stores the GitHub access token, sealed to the account, when the repo scope was granted", async () => {
    const deps = makeDeps();
    await handleGithubCallback(callback("code=abc&state=state-123", { session: signedInSession }), deps);
    const [userId, sealed] = deps.saveGithubAccessToken.mock.calls[0]!;
    expect(userId).toBe(user.id);
    expect(sealed).not.toBeNull();
    expect(openCredential(sealed, githubAccessTokenSlot(user.id), credKeys)).toBe("gho_token");
  });

  it("stores no access token when the user did not grant the repo scope", async () => {
    const deps = makeDeps({ tokenResult: { ok: true, accessToken: "gho_token", scopes: ["read:user"] } });
    await handleGithubCallback(callback("code=abc&state=state-123", { session: signedInSession }), deps);
    expect(deps.saveGithubAccessToken).toHaveBeenCalledWith(user.id, null);
  });

  it("seals no token when the signed-in account itself has no Gitea link yet", async () => {
    const deps = makeDeps();
    await handleGithubCallback(callback("code=abc&state=state-123", { session: giteaLessSession }), deps);
    const call = deps.linkGithubIdentity.mock.calls[0]![0];
    expect(call).toMatchObject({ userId: giteaLessSession.uid, giteaRefreshTokenEnc: null });
  });
});

describe("handleGithubCallback -- login mode (signed out)", () => {
  const sealedRefresh = sealCredential("stored-refresh", { column: "user_identities.gitea_refresh_token", userId: user.id, subject: "github" }, credKeys);

  it("creates a new, Gitea-less account for a GitHub identity that has never signed in (decision 22)", async () => {
    const deps = makeDeps({ identity: undefined });
    const res = await handleGithubCallback(callback("code=abc&state=state-123"), deps);

    expect(deps.createAccount).toHaveBeenCalledWith({ username: "kayela-c", displayName: null });
    expect(deps.linkGithubIdentity).toHaveBeenCalledWith({
      userId: newUser.id,
      forgeUserId: "42",
      username: "kayela-c",
      giteaRefreshTokenEnc: null,
    });
    expect(res.headers.get("location")).toBe("/settings/connections");
    const session = unseal(SESSION_COOKIE, cookieValue(res, SESSION_COOKIE), keys, sessionSchema);
    expect(session).toMatchObject({ uid: newUser.id, username: newUser.username, gitea_id: null, access_token: null });
  });

  it("refuses account creation for a GitHub username not on the allow-list", async () => {
    const deps = makeDeps({ identity: undefined, allowed: ["someone-else"] });
    const res = await handleGithubCallback(callback("code=abc&state=state-123"), deps);
    expect(res.headers.get("location")).toBe("/login?error=github_not_allowed");
    expect(deps.createAccount).not.toHaveBeenCalled();
  });

  it("signs a known, still Gitea-less account straight in without touching Gitea", async () => {
    const deps = makeDeps({ identity: { userId: newUser.id, giteaRefreshTokenEnc: null } });
    const res = await handleGithubCallback(callback("code=abc&state=state-123"), deps);

    expect(deps.refresh).not.toHaveBeenCalled();
    expect(deps.createAccount).not.toHaveBeenCalled();
    const session = unseal(SESSION_COOKIE, cookieValue(res, SESSION_COOKIE), keys, sessionSchema);
    expect(session).toMatchObject({ uid: newUser.id, gitea_id: null, access_token: null });
  });

  it("mints a Gitea session from the linked account's stored refresh token", async () => {
    const deps = makeDeps({ identity: { userId: user.id, giteaRefreshTokenEnc: sealedRefresh } });
    const res = await handleGithubCallback(callback("code=abc&state=state-123"), deps);

    expect(res.headers.get("location")).toBe("/settings/connections");
    expect(deps.refresh).toHaveBeenCalledWith(expect.anything(), "stored-refresh");
    const session = unseal(SESSION_COOKIE, cookieValue(res, SESSION_COOKIE), keys, sessionSchema);
    expect(session).toMatchObject({ uid: user.id, gitea_id: 7, access_token: "new-access" });
    // Gitea rotates the refresh token; the stored snapshot is kept current.
    expect(deps.touchGithubIdentityToken).toHaveBeenCalledWith(user.id, expect.any(String));
  });

  it("re-checks org membership and refuses a former member", async () => {
    const deps = makeDeps({ identity: { userId: user.id, giteaRefreshTokenEnc: sealedRefresh }, member: false });
    const res = await handleGithubCallback(callback("code=abc&state=state-123"), deps);
    expect(res.headers.get("location")).toBe("/login?error=not_member");
    expect(deps.upsertUser).not.toHaveBeenCalled();
  });

  it("asks for a fresh link when the stored Gitea token was revoked", async () => {
    const deps = makeDeps({
      identity: { userId: user.id, giteaRefreshTokenEnc: sealedRefresh },
      refreshResult: { ok: false, kind: "rejected", message: "revoked" },
    });
    const res = await handleGithubCallback(callback("code=abc&state=state-123"), deps);
    expect(res.headers.get("location")).toBe("/login?error=github_link_expired");
  });
});

describe("handleGithubCallback -- shared failure modes", () => {
  it.each([
    ["a state mismatch", callback("code=abc&state=forged"), "github_expired"],
    ["a missing login cookie", callback("code=abc&state=state-123", { state: null }), "github_expired"],
    ["a denial at GitHub", callback("error=access_denied&state=state-123"), "github_denied"],
  ])("refuses %s without exchanging the code", async (_label, req, reason) => {
    const deps = makeDeps();
    const res = await handleGithubCallback(req, deps);
    expect(res.headers.get("location")).toBe(`/login?error=${reason}`);
    expect(deps.exchangeGithub).not.toHaveBeenCalled();
  });

  it("reports a rejected code exchange", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps({ tokenResult: { ok: false, kind: "rejected", message: "bad code" } });
    const res = await handleGithubCallback(callback("code=abc&state=state-123"), deps);
    expect(res.headers.get("location")).toBe("/login?error=github_failed");
  });
});
