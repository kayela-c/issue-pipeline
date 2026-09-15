import { randomBytes } from "node:crypto";
import type { Context } from "@netlify/functions";
import { describe, expect, it, vi } from "vitest";
import type { User } from "../db/users";
import { SESSION_COOKIE, seal, type Keyring, type Session } from "./session";
import { createWithAccount, type AccountDeps } from "./withAccount";

const NOW = 1_800_000_000;
const MAX_AGE = 7 * 86_400;
const ORIGIN = "http://localhost:8888";
const context = {} as Context;
const keys: Keyring = { current: randomBytes(32) };

const user: User = {
  id: "00000000-0000-4000-8000-000000000001",
  giteaId: null,
  username: "kayela-c",
  displayName: null,
  createdAt: new Date(),
  lastSeenAt: new Date(),
};

const session: Session = {
  uid: user.id,
  username: "kayela-c",
  gitea_id: null,
  access_token: null,
  refresh_token: null,
  access_expires_at: null,
  session_started_at: NOW - 60,
};

function makeDeps(overrides: Partial<AccountDeps> = {}) {
  return {
    keys: () => keys,
    sessionMaxAgeSeconds: () => MAX_AGE,
    now: () => NOW,
    getUserById: vi.fn(async () => user),
    ...overrides,
  } satisfies AccountDeps;
}

const cookieFor = (s: Session) => `${SESSION_COOKIE}=${seal(SESSION_COOKIE, s, keys)}`;
const request = (init: { headers?: Record<string, string> } = {}) => new Request(`${ORIGIN}/api/me`, init);
const ok = vi.fn(async () => new Response("ok"));

describe("withAccount", () => {
  it("authenticates a Gitea-less account with no Gitea call at all", async () => {
    const deps = makeDeps();
    const res = await createWithAccount(deps)(ok)(request({ headers: { cookie: cookieFor(session) } }), context);
    expect(res.status).toBe(200);
    expect(ok).toHaveBeenCalledWith(expect.anything(), { user }, context);
  });

  it("401s with no session cookie", async () => {
    const res = await createWithAccount(makeDeps())(ok)(request(), context);
    expect(res.status).toBe(401);
  });

  it("401s and clears the cookie for an undecryptable session", async () => {
    const res = await createWithAccount(makeDeps())(ok)(
      request({ headers: { cookie: `${SESSION_COOKIE}=v1.garbage` } }),
      context,
    );
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()[0]).toMatch(/^__Host-ip_session=; .*Max-Age=0$/);
  });

  it("401s past the session's absolute max age", async () => {
    const old = { ...session, session_started_at: NOW - MAX_AGE };
    const res = await createWithAccount(makeDeps())(ok)(request({ headers: { cookie: cookieFor(old) } }), context);
    expect(res.status).toBe(401);
    expect(ok).not.toHaveBeenCalled();
  });

  it("401s when the account no longer exists", async () => {
    const deps = makeDeps({ getUserById: vi.fn(async () => undefined) });
    const res = await createWithAccount(deps)(ok)(request({ headers: { cookie: cookieFor(session) } }), context);
    expect(res.status).toBe(401);
  });

  it("rejects a cross-site POST before touching the session", async () => {
    const res = await createWithAccount(makeDeps())(ok)(
      new Request(ORIGIN, { method: "POST", headers: { origin: "https://evil.example" } }),
      context,
    );
    expect(res.status).toBe(403);
  });
});
