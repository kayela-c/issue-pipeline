import { randomBytes } from "node:crypto";
import type { Context } from "@netlify/functions";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "../db/users";
import { fakeForge } from "../forge/fake";
import { ForgeError, type ForgeClient } from "../forge/types";
import type { TokenResult } from "./oauth";
import { SESSION_COOKIE, seal, sessionSchema, unseal, type Keyring, type Session } from "./session";
import { REFRESH_MARGIN_SECONDS, createWithAuth, redact, type AuthDeps } from "./withAuth";

const TOKEN = "gta_secret_token_value";
const NOW = 1_800_000_000;
const MAX_AGE = 7 * 86_400;
const ORIGIN = "http://localhost:8888";
const context = {} as Context;
const keys: Keyring = { current: randomBytes(32) };

const user: User = {
  id: "00000000-0000-4000-8000-000000000001",
  giteaId: 7,
  username: "kayela",
  displayName: "Kayela",
  createdAt: new Date(),
  lastSeenAt: new Date(),
};

const baseSession: Session = {
  uid: user.id,
  gitea_id: 7,
  username: "kayela",
  access_token: TOKEN,
  refresh_token: "refresh-1",
  access_expires_at: NOW + 3600,
  session_started_at: NOW - 60,
};

function makeDeps(overrides: { forge?: Partial<ForgeClient>; refresh?: () => Promise<TokenResult> } = {}) {
  const tokensSeen: string[] = [];
  const deps = {
    createForge: (token: string) => {
      tokensSeen.push(token);
      return fakeForge({
        getCurrentUser: async () => ({ id: 7, username: "kayela", fullName: "Kayela" }),
        isOrgMember: async () => true,
        ...overrides.forge,
      });
    },
    upsertUser: vi.fn(async () => user),
    allowedOrg: () => "TrueRoster",
    keys: () => keys,
    oauth: () => ({ giteaBaseUrl: "https://git.example.com", clientId: "id", clientSecret: "secret" }),
    refresh: vi.fn(overrides.refresh ?? (async (): Promise<TokenResult> => ({ ok: false, kind: "transport", message: "unused" }))),
    sessionMaxAgeSeconds: () => MAX_AGE,
    now: () => NOW,
  } satisfies AuthDeps;
  return { deps, tokensSeen };
}

const cookieFor = (session: Session) => `${SESSION_COOKIE}=${seal(SESSION_COOKIE, session, keys)}`;

function request(init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Request(`${ORIGIN}/api/me`, init);
}

const ok = vi.fn(async () => new Response("ok"));

afterEach(() => {
  vi.restoreAllMocks();
  ok.mockClear();
});

describe("withAuth: bearer tokens", () => {
  it("returns 401 without credentials or with a malformed header", async () => {
    const handler = createWithAuth(makeDeps().deps)(ok);
    const cases: Record<string, string>[] = [{}, { authorization: "Basic abc" }, { authorization: "Bearer" }];
    for (const headers of cases) {
      expect((await handler(request({ headers }), context)).status).toBe(401);
    }
    expect(ok).not.toHaveBeenCalled();
  });

  it("returns 401 when Gitea rejects the token", async () => {
    const { deps } = makeDeps({
      forge: { getCurrentUser: async () => { throw new ForgeError("GET /user returned 401", 401, false); } },
    });
    const res = await createWithAuth(deps)(ok)(request({ headers: { authorization: `Bearer ${TOKEN}` } }), context);
    expect(res.status).toBe(401);
    expect(deps.upsertUser).not.toHaveBeenCalled();
  });

  it("returns 403 for a user outside the allowed org", async () => {
    const { deps } = makeDeps({ forge: { isOrgMember: async () => false } });
    const res = await createWithAuth(deps)(ok)(request({ headers: { authorization: `Bearer ${TOKEN}` } }), context);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
    expect(ok).not.toHaveBeenCalled();
  });

  it("skips the CSRF check and never sets cookies", async () => {
    const { deps } = makeDeps();
    const res = await createWithAuth(deps)(ok)(
      request({ method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }),
      context,
    );
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("withAuth: session cookies", () => {
  it("authenticates with a valid session and passes its token to the forge", async () => {
    const { deps, tokensSeen } = makeDeps();
    const handler = vi.fn(async () => new Response("ok"));
    const res = await createWithAuth(deps)(handler)(request({ headers: { cookie: cookieFor(baseSession) } }), context);
    expect(res.status).toBe(200);
    expect(tokensSeen).toEqual([TOKEN]);
    expect(handler).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ user, giteaToken: TOKEN }), context);
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("rejects a cross-site POST before touching the session", async () => {
    const { deps, tokensSeen } = makeDeps();
    const res = await createWithAuth(deps)(ok)(
      request({ method: "POST", headers: { cookie: cookieFor(baseSession), origin: "https://evil.example" } }),
      context,
    );
    expect(res.status).toBe(403);
    expect(tokensSeen).toEqual([]);
  });

  it("accepts a same-origin POST", async () => {
    const { deps } = makeDeps();
    const res = await createWithAuth(deps)(ok)(
      request({ method: "POST", headers: { cookie: cookieFor(baseSession), origin: ORIGIN } }),
      context,
    );
    expect(res.status).toBe(200);
  });

  it("clears an undecryptable cookie", async () => {
    const { deps } = makeDeps();
    const res = await createWithAuth(deps)(ok)(request({ headers: { cookie: `${SESSION_COOKIE}=v1.garbage` } }), context);
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()[0]).toMatch(/^__Host-ip_session=; .*Max-Age=0$/);
  });

  it("ends a session past its absolute max age", async () => {
    const { deps } = makeDeps();
    const old = { ...baseSession, session_started_at: NOW - MAX_AGE };
    const res = await createWithAuth(deps)(ok)(request({ headers: { cookie: cookieFor(old) } }), context);
    expect(res.status).toBe(401);
    expect(ok).not.toHaveBeenCalled();
  });

  it("refreshes a token near expiry and re-issues the cookie", async () => {
    const { deps, tokensSeen } = makeDeps({
      refresh: async () => ({ ok: true, token: { access_token: "fresh-access", refresh_token: "refresh-2", expires_in: 3600 } }),
    });
    const expiring = { ...baseSession, access_expires_at: NOW + REFRESH_MARGIN_SECONDS - 1 };
    const res = await createWithAuth(deps)(ok)(request({ headers: { cookie: cookieFor(expiring) } }), context);

    expect(res.status).toBe(200);
    expect(deps.refresh).toHaveBeenCalledWith(expect.anything(), "refresh-1");
    expect(tokensSeen).toEqual(["fresh-access"]);

    const [cookie] = res.headers.getSetCookie();
    const value = cookie!.split(";")[0]!.slice(`${SESSION_COOKIE}=`.length);
    expect(unseal(SESSION_COOKIE, value, keys, sessionSchema)).toMatchObject({
      access_token: "fresh-access",
      refresh_token: "refresh-2",
      access_expires_at: NOW + 3600,
      session_started_at: expiring.session_started_at,
    });
  });

  it("signs out when Gitea rejects the refresh token", async () => {
    const { deps } = makeDeps({ refresh: async () => ({ ok: false, kind: "rejected", message: "revoked" }) });
    const expiring = { ...baseSession, access_expires_at: NOW };
    const res = await createWithAuth(deps)(ok)(request({ headers: { cookie: cookieFor(expiring) } }), context);
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()[0]).toMatch(/Max-Age=0$/);
  });

  it("keeps the session when refresh fails for network reasons", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = makeDeps({ refresh: async () => ({ ok: false, kind: "transport", message: "fetch failed" }) });
    const expiring = { ...baseSession, access_expires_at: NOW };
    const res = await createWithAuth(deps)(ok)(request({ headers: { cookie: cookieFor(expiring) } }), context);
    expect(res.status).toBe(502);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("rejects a session whose Gitea account no longer matches", async () => {
    const { deps } = makeDeps({ forge: { getCurrentUser: async () => ({ id: 99, username: "someone-else" }) } });
    const res = await createWithAuth(deps)(ok)(request({ headers: { cookie: cookieFor(baseSession) } }), context);
    expect(res.status).toBe(401);
  });

  it("returns 403 for a session user removed from the org", async () => {
    const { deps } = makeDeps({ forge: { isOrgMember: async () => false } });
    const res = await createWithAuth(deps)(ok)(request({ headers: { cookie: cookieFor(baseSession) } }), context);
    expect(res.status).toBe(403);
  });
});

describe("withAuth: failures never leak the token", () => {
  it("maps a Gitea outage to 502", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = makeDeps({
      forge: { getCurrentUser: async () => { throw new ForgeError(`Gitea returned 503 for Bearer ${TOKEN}`, 503, true); } },
    });
    const res = await createWithAuth(deps)(ok)(request({ headers: { cookie: cookieFor(baseSession) } }), context);
    expect(res.status).toBe(502);
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
  });

  it("maps unexpected errors to 500", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = makeDeps();
    deps.upsertUser.mockRejectedValue(new Error(`db exploded near ${TOKEN}`));
    const res = await createWithAuth(deps)(ok)(request({ headers: { authorization: `Bearer ${TOKEN}` } }), context);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(TOKEN);
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
  });

  it("redact removes secrets and bearer headers", () => {
    expect(redact(`a ${TOKEN} b`, TOKEN)).toBe("a [redacted] b");
    expect(redact("Authorization: Bearer abc.def")).toBe("Authorization: Bearer [redacted]");
  });
});
