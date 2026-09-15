import { describe, expect, it } from "vitest";
import { exchangeGithubCode, fetchGithubUser, githubAllowedUsersFromEnv, githubAuthorizeUrl } from "./github";

const cfg = { clientId: "id", clientSecret: "secret" };

describe("githubAuthorizeUrl", () => {
  it("asks for read:user and repo (Phase 9 repository access)", () => {
    const url = new URL(githubAuthorizeUrl(cfg, { redirectUri: "https://app.example/api/auth/github/callback", state: "s" }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe("read:user repo");
    expect(url.searchParams.get("allow_signup")).toBe("false");
    expect(url.searchParams.get("state")).toBe("s");
  });
});

describe("githubAllowedUsersFromEnv", () => {
  it("lower-cases and trims a comma-separated list", () => {
    const prev = process.env.GITHUB_ALLOWED_USERS;
    process.env.GITHUB_ALLOWED_USERS = " Kayela-C, otheruser ,, ";
    try {
      expect(githubAllowedUsersFromEnv()).toEqual(new Set(["kayela-c", "otheruser"]));
    } finally {
      process.env.GITHUB_ALLOWED_USERS = prev;
    }
  });

  it("is empty (nobody allowed) when unset", () => {
    const prev = process.env.GITHUB_ALLOWED_USERS;
    delete process.env.GITHUB_ALLOWED_USERS;
    try {
      expect(githubAllowedUsersFromEnv().size).toBe(0);
    } finally {
      process.env.GITHUB_ALLOWED_USERS = prev;
    }
  });
});

describe("exchangeGithubCode", () => {
  it("returns the access token and the scopes actually granted", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ access_token: "gho_abc", scope: "read:user,repo" }), { status: 200 });
    const result = await exchangeGithubCode(cfg, { code: "c", redirectUri: "r" }, fetchImpl as typeof fetch);
    expect(result).toEqual({ ok: true, accessToken: "gho_abc", scopes: ["read:user", "repo"] });
  });

  it("treats GitHub's 200-with-error body as rejected", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "bad_verification_code", error_description: "The code passed is incorrect." }), { status: 200 });
    const result = await exchangeGithubCode(cfg, { code: "c", redirectUri: "r" }, fetchImpl as typeof fetch);
    expect(result).toMatchObject({ ok: false, kind: "rejected", message: "The code passed is incorrect." });
  });

  it("treats a 5xx as transport trouble", async () => {
    const fetchImpl = async () => new Response("oops", { status: 502 });
    const result = await exchangeGithubCode(cfg, { code: "c", redirectUri: "r" }, fetchImpl as typeof fetch);
    expect(result).toMatchObject({ ok: false, kind: "transport" });
  });
});

describe("fetchGithubUser", () => {
  it("returns the id (as a string) and login", async () => {
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
      return new Response(JSON.stringify({ id: 42, login: "kayela-c" }), { status: 200 });
    };
    const result = await fetchGithubUser("tok", fetchImpl as typeof fetch);
    expect(result).toEqual({ ok: true, user: { id: "42", login: "kayela-c" } });
  });

  it("rejects on a 401 (revoked token)", async () => {
    const fetchImpl = async () => new Response("", { status: 401 });
    const result = await fetchGithubUser("tok", fetchImpl as typeof fetch);
    expect(result).toMatchObject({ ok: false, kind: "rejected" });
  });
});
