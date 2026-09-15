import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { User } from "../db/users";
import { fakeForge } from "../forge/fake";
import type { ForgeClient } from "../forge/types";
import { GiteaLinkedElsewhere } from "../db/users";
import { handleCallback, handleLogin, handleLogout, type LoginDeps } from "./handlers";
import { codeChallenge, type TokenResult } from "./oauth";
import {
  OAUTH_COOKIE,
  SESSION_COOKIE,
  oauthStateSchema,
  seal,
  sessionSchema,
  unseal,
  type Keyring,
  type OAuthState,
  type Session,
} from "./session";

const NOW = 1_800_000_000;
const ORIGIN = "http://localhost:8888";
const keys: Keyring = { current: randomBytes(32) };

const user: User = {
  id: "00000000-0000-4000-8000-000000000001",
  giteaId: 7,
  username: "kayela",
  displayName: null,
  createdAt: new Date(),
  lastSeenAt: new Date(),
};

function makeDeps(opts: { member?: boolean; exchange?: TokenResult; linkError?: unknown } = {}) {
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
    refresh: vi.fn(),
    sessionMaxAgeSeconds: () => 7 * 86_400,
    now: () => NOW,
    exchange: vi.fn(async () =>
      opts.exchange ?? { ok: true as const, token: { access_token: "access", refresh_token: "refresh", expires_in: 3600 } },
    ),
    linkGitea: vi.fn(async () => {
      if (opts.linkError) throw opts.linkError;
      return user;
    }),
  } satisfies LoginDeps;
}

const cookieValue = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0]
    ?.slice(name.length + 1);

const pending: OAuthState = { state: "state-123", code_verifier: "v".repeat(43), return_to: "/board", created_at: NOW - 30 };

function callback(query: string, state: OAuthState | null = pending, session?: Session) {
  const cookies: string[] = [];
  if (state) cookies.push(`${OAUTH_COOKIE}=${seal(OAUTH_COOKIE, state, keys)}`);
  if (session) cookies.push(`${SESSION_COOKIE}=${seal(SESSION_COOKIE, session, keys)}`);
  return new Request(`${ORIGIN}/api/auth/callback?${query}`, { headers: { cookie: cookies.join("; ") } });
}

const giteaLessSession: Session = {
  uid: "00000000-0000-4000-8000-000000000002",
  username: "kayela-c",
  gitea_id: null,
  access_token: null,
  refresh_token: null,
  access_expires_at: null,
  session_started_at: NOW - 10,
};

describe("handleLogin", () => {
  it("redirects to Gitea with PKCE and stores the verifier in an encrypted cookie", () => {
    const res = handleLogin(new Request(`${ORIGIN}/api/auth/login?return_to=%2Fboard`), makeDeps());
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback`);

    const state = unseal(OAUTH_COOKIE, cookieValue(res, OAUTH_COOKIE), keys, oauthStateSchema)!;
    expect(state.return_to).toBe("/board");
    expect(location.searchParams.get("state")).toBe(state.state);
    expect(location.searchParams.get("code_challenge")).toBe(codeChallenge(state.code_verifier));
  });

  it("drops an off-site return_to", () => {
    const res = handleLogin(new Request(`${ORIGIN}/api/auth/login?return_to=https://evil.example`), makeDeps());
    expect(unseal(OAUTH_COOKIE, cookieValue(res, OAUTH_COOKIE), keys, oauthStateSchema)!.return_to).toBe("/");
  });
});

describe("handleCallback", () => {
  it("exchanges the code, sets the session, and returns to the saved path", async () => {
    const deps = makeDeps();
    const res = await handleCallback(callback("code=abc&state=state-123"), deps);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/board");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(deps.exchange).toHaveBeenCalledWith(expect.anything(), {
      code: "abc",
      codeVerifier: pending.code_verifier,
      redirectUri: `${ORIGIN}/api/auth/callback`,
    });

    const session = unseal(SESSION_COOKIE, cookieValue(res, SESSION_COOKIE), keys, sessionSchema);
    expect(session).toEqual({
      uid: user.id,
      gitea_id: 7,
      username: "kayela",
      access_token: "access",
      refresh_token: "refresh",
      access_expires_at: NOW + 3600,
      session_started_at: NOW,
    });
    expect(cookieValue(res, OAUTH_COOKIE)).toBe("");
  });

  it.each([
    ["a state mismatch", callback("code=abc&state=forged"), "expired"],
    ["a missing login cookie", callback("code=abc&state=state-123", null), "expired"],
    ["a stale login cookie", callback("code=abc&state=state-123", { ...pending, created_at: NOW - 601 }), "expired"],
    ["a denial at Gitea", callback("error=access_denied&state=state-123"), "denied"],
  ])("refuses %s without exchanging the code", async (_label, req, reason) => {
    const deps = makeDeps();
    const res = await handleCallback(req, deps);
    expect(res.headers.get("location")).toBe(`/login?error=${reason}`);
    expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined();
    expect(deps.exchange).not.toHaveBeenCalled();
  });

  it("gives a non-member no session", async () => {
    const deps = makeDeps({ member: false });
    const res = await handleCallback(callback("code=abc&state=state-123"), deps);
    expect(res.headers.get("location")).toBe("/login?error=not_member");
    expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined();
    expect(deps.upsertUser).not.toHaveBeenCalled();
  });

  it("reports a rejected code exchange", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps({ exchange: { ok: false, kind: "rejected", message: "invalid client secret" } });
    const res = await handleCallback(callback("code=abc&state=state-123"), deps);
    expect(res.headers.get("location")).toBe("/login?error=failed");
  });

  it("links Gitea to a signed-in, Gitea-less account instead of creating a second one", async () => {
    const deps = makeDeps();
    const res = await handleCallback(callback("code=abc&state=state-123", pending, giteaLessSession), deps);

    expect(res.headers.get("location")).toBe("/board");
    expect(deps.linkGitea).toHaveBeenCalledWith(giteaLessSession.uid, { id: 7, username: "kayela" });
    expect(deps.upsertUser).not.toHaveBeenCalled();
    const session = unseal(SESSION_COOKIE, cookieValue(res, SESSION_COOKIE), keys, sessionSchema);
    expect(session).toMatchObject({ uid: user.id, gitea_id: 7, access_token: "access" });
  });

  it("still re-checks org membership when linking Gitea to a signed-in account", async () => {
    const deps = makeDeps({ member: false });
    const res = await handleCallback(callback("code=abc&state=state-123", pending, giteaLessSession), deps);
    expect(res.headers.get("location")).toBe("/login?error=not_member");
    expect(deps.linkGitea).not.toHaveBeenCalled();
  });

  it("reports a Gitea account already linked to a different sign-in", async () => {
    const deps = makeDeps({ linkError: new GiteaLinkedElsewhere() });
    const res = await handleCallback(callback("code=abc&state=state-123", pending, giteaLessSession), deps);
    expect(res.headers.get("location")).toBe("/login?error=gitea_already_linked");
  });

  it("does not treat an already-Gitea-linked session as link mode", async () => {
    const linkedSession: Session = { ...giteaLessSession, gitea_id: 99, access_token: "old", refresh_token: "old-r", access_expires_at: NOW + 100 };
    const deps = makeDeps();
    const res = await handleCallback(callback("code=abc&state=state-123", pending, linkedSession), deps);
    expect(deps.linkGitea).not.toHaveBeenCalled();
    expect(deps.upsertUser).toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("/board");
  });
});

describe("handleLogout", () => {
  it("clears the session for a same-origin POST", () => {
    const res = handleLogout(new Request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { origin: ORIGIN } }));
    expect(res.status).toBe(204);
    expect(cookieValue(res, SESSION_COOKIE)).toBe("");
  });

  it("rejects a cross-site POST", () => {
    const res = handleLogout(
      new Request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { origin: "https://evil.example" } }),
    );
    expect(res.status).toBe(403);
  });
});
