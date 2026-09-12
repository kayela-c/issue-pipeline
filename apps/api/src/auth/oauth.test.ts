import { describe, expect, it, vi } from "vitest";
import { passesCsrfCheck } from "./csrf";
import {
  SCOPES,
  authorizeUrl,
  codeChallenge,
  randomToken,
  refreshTokens,
  safeReturnTo,
  type OAuthConfig,
} from "./oauth";

const cfg: OAuthConfig = {
  giteaBaseUrl: "https://git.example.com",
  clientId: "client-id",
  clientSecret: "client-secret",
};

describe("oauth helpers", () => {
  it("requests only valid Gitea scope names", () => {
    // Gitea widens a token to all scopes if any name fails to parse.
    const valid = ["activitypub", "admin", "misc", "notification", "organization", "package", "issue", "repository", "user"]
      .flatMap((c) => [`read:${c}`, `write:${c}`]);
    for (const scope of SCOPES.split(" ")) {
      expect(valid).toContain(scope);
    }
  });

  it("computes the RFC 7636 example challenge", () => {
    expect(codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    expect(randomToken()).toMatch(/^[\w-]{43}$/);
  });

  it("builds the authorize URL with PKCE S256", () => {
    const url = new URL(
      authorizeUrl(cfg, { redirectUri: "http://localhost:8888/api/auth/callback", state: "s", codeChallenge: "c" }),
    );
    expect(url.origin + url.pathname).toBe("https://git.example.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client-id",
      redirect_uri: "http://localhost:8888/api/auth/callback",
      response_type: "code",
      scope: SCOPES,
      state: "s",
      code_challenge: "c",
      code_challenge_method: "S256",
    });
  });

  it("only allows same-site relative return paths", () => {
    expect(safeReturnTo("/board?repo=1")).toBe("/board?repo=1");
    for (const bad of [null, "", "https://evil.example", "//evil.example", "/\\evil.example", "board", "/api/auth/logout"]) {
      expect(safeReturnTo(bad)).toBe("/");
    }
  });

  it("classifies token endpoint failures", async () => {
    const respond = (status: number, body: unknown) =>
      vi.fn(async () => new Response(JSON.stringify(body), { status }));

    await expect(refreshTokens(cfg, "rt", respond(200, { access_token: "a", refresh_token: "r", expires_in: 3600 })))
      .resolves.toEqual({ ok: true, token: { access_token: "a", refresh_token: "r", expires_in: 3600 } });
    await expect(refreshTokens(cfg, "rt", respond(400, { error: "invalid_grant", error_description: "token was already used" })))
      .resolves.toEqual({ ok: false, kind: "rejected", message: "token was already used" });
    await expect(refreshTokens(cfg, "rt", respond(503, {})))
      .resolves.toMatchObject({ ok: false, kind: "transport" });
    await expect(refreshTokens(cfg, "rt", vi.fn(async () => { throw new TypeError("fetch failed"); })))
      .resolves.toMatchObject({ ok: false, kind: "transport" });
  });

  it("sends the client secret and refresh token in the form body", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ access_token: "a", expires_in: 1 })));
    await refreshTokens(cfg, "rt", fetch);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt",
      client_id: "client-id",
      client_secret: "client-secret",
    });
  });
});

describe("passesCsrfCheck", () => {
  const req = (method: string, headers: Record<string, string>, body?: string) =>
    new Request("http://localhost:8888/api/drafts/1", { method, headers, body });

  it("allows safe methods without an Origin", () => {
    expect(passesCsrfCheck(req("GET", {}))).toBe(true);
  });

  it("requires a same-origin Origin on state-changing requests", () => {
    expect(passesCsrfCheck(req("POST", {}))).toBe(false);
    expect(passesCsrfCheck(req("POST", { origin: "https://evil.example" }))).toBe(false);
    expect(passesCsrfCheck(req("POST", { origin: "http://localhost:8888" }))).toBe(true);
  });

  it("rejects cross-site Sec-Fetch-Site and non-JSON bodies", () => {
    const origin = "http://localhost:8888";
    expect(passesCsrfCheck(req("POST", { origin, "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(passesCsrfCheck(req("PATCH", { origin, "content-type": "text/plain" }, "{}"))).toBe(false);
    expect(passesCsrfCheck(req("PATCH", { origin, "content-type": "application/json" }, "{}"))).toBe(true);
  });
});
