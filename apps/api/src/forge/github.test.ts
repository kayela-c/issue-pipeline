import { describe, expect, it, vi } from "vitest";
import { GitHubForge } from "./github";
import { ForgeError } from "./types";

const TOKEN = "gho_secret_token_value";

function forgeWith(responses: Array<Response | Error>) {
  const fetch = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    return next;
  });
  const forge = new GitHubForge(TOKEN, { fetch, backoffMs: () => 0 });
  return { forge, fetch };
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const call = (fetch: ReturnType<typeof vi.fn>, i: number) => fetch.mock.calls[i] as unknown as [string, RequestInit];

const repo = (overrides: Record<string, unknown> = {}) => ({
  name: "app",
  full_name: "kayela-c/app",
  description: null,
  private: true,
  archived: false,
  has_issues: true,
  default_branch: "main",
  size: 120,
  owner: { login: "kayela-c" },
  ...overrides,
});

describe("GitHubForge", () => {
  it("calls the GitHub API with the bearer token, API version, and user agent", async () => {
    const { forge, fetch } = forgeWith([jsonResponse({ id: 42, login: "kayela-c", name: null })]);
    await expect(forge.getCurrentUser()).resolves.toEqual({ id: 42, username: "kayela-c", fullName: undefined });

    const [url, init] = call(fetch, 0);
    expect(url).toBe("https://api.github.com/user");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
    expect(headers["user-agent"]).toBe("issue-pipeline");
    expect(forge.templateDirs).toEqual([".github/ISSUE_TEMPLATE", ".github/issue_template"]);
  });

  it("lists accessible repos filtered by name, across org and collaborator affiliations", async () => {
    const { forge, fetch } = forgeWith([
      jsonResponse([repo(), repo({ name: "docs", full_name: "TrueRoster/docs", owner: { login: "TrueRoster" } })]),
    ]);
    const repos = await forge.listAccessibleRepos("docs");
    expect(repos).toEqual([
      { owner: "TrueRoster", name: "docs", fullName: "TrueRoster/docs", description: "", private: true, archived: false, hasIssues: true },
    ]);
    expect(call(fetch, 0)[0]).toContain("affiliation=owner%2Ccollaborator%2Corganization_member");
  });

  it("treats a zero-size repo as empty", async () => {
    const { forge } = forgeWith([jsonResponse(repo({ size: 0 }))]);
    await expect(forge.getRepo("kayela-c", "app")).resolves.toEqual({ defaultBranch: "main", hasIssues: true, empty: true });
  });

  it("reads the recursive tree, keeping only files", async () => {
    const { forge } = forgeWith([
      jsonResponse({
        truncated: false,
        tree: [
          { path: "src", type: "tree" },
          { path: "src/a.ts", type: "blob", size: 10 },
        ],
      }),
    ]);
    await expect(forge.getTree("o", "r", "abc")).resolves.toEqual([{ path: "src/a.ts", size: 10 }]);
  });

  it("refuses a truncated tree rather than drafting from part of the repo", async () => {
    const { forge } = forgeWith([jsonResponse({ truncated: true, tree: [] })]);
    await expect(forge.getTree("o", "r", "abc")).rejects.toMatchObject({ status: 413 });
  });

  it("fetches raw file contents with the raw media type", async () => {
    const { forge, fetch } = forgeWith([new Response("# Readme", { status: 200 })]);
    await expect(forge.getRawFile("o", "r", "docs/READ ME.md", "abc")).resolves.toBe("# Readme");
    const [url, init] = call(fetch, 0);
    expect(url).toBe("https://api.github.com/repos/o/r/contents/docs/READ%20ME.md?ref=abc");
    expect((init.headers as Record<string, string>).accept).toBe("application/vnd.github.raw+json");
  });

  it("creates issues with label names (GitHub has no label ids in this call)", async () => {
    const { forge, fetch } = forgeWith([jsonResponse({ id: 900, number: 7, html_url: "https://github.com/o/r/issues/7" }, 201)]);
    await expect(
      forge.createIssue("o", "r", { title: "t", body: "b", labels: [{ id: 1, name: "bug" }] }),
    ).resolves.toEqual({ number: 7, url: "https://github.com/o/r/issues/7" });
    expect(JSON.parse(call(fetch, 0)[1].body as string)).toEqual({ title: "t", body: "b", labels: ["bug"] });
  });

  it("does not retry an ambiguous issue creation, and marks it retryable for reconcile", async () => {
    const { forge, fetch } = forgeWith([new Response("", { status: 502 })]);
    const err = await forge.createIssue("o", "r", { title: "t", body: "b", labels: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect(err).toMatchObject({ status: 502, retryable: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("links a dependency by the blocking issue's id, not its number", async () => {
    const { forge, fetch } = forgeWith([
      jsonResponse({ id: 555, number: 3, html_url: "u" }),
      jsonResponse({}, 201),
    ]);
    await forge.addDependency("o", "r", 7, 3);
    expect(call(fetch, 0)[0]).toBe("https://api.github.com/repos/o/r/issues/3");
    expect(call(fetch, 1)[0]).toBe("https://api.github.com/repos/o/r/issues/7/dependencies/blocked_by");
    expect(JSON.parse(call(fetch, 1)[1].body as string)).toEqual({ issue_id: 555 });
  });

  it("finds issues by creator, dropping pull requests", async () => {
    const { forge, fetch } = forgeWith([
      jsonResponse([
        { id: 1, number: 7, html_url: "u7", body: "marker" },
        { id: 2, number: 8, html_url: "u8", body: "pr", pull_request: {} },
      ]),
    ]);
    const issues = await forge.listIssuesCreatedBySince("o", "r", "kayela-c", new Date("2026-09-15T00:00:00Z"));
    expect(issues).toEqual([{ number: 7, body: "marker", url: "u7" }]);
    expect(call(fetch, 0)[0]).toContain("creator=kayela-c");
  });

  it("retries a rate-limited 403 and gives up as retryable", async () => {
    const limited = () => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    const { forge, fetch } = forgeWith([limited(), limited(), limited()]);
    await expect(forge.listLabels("o", "r")).rejects.toMatchObject({ status: 429, retryable: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry a plain 403 (no access)", async () => {
    const { forge, fetch } = forgeWith([new Response("", { status: 403, headers: { "x-ratelimit-remaining": "4999" } })]);
    await expect(forge.listLabels("o", "r")).rejects.toMatchObject({ status: 403, retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never puts the token in an error message", async () => {
    const { forge } = forgeWith([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")]);
    const err = (await forge.getCurrentUser().catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(TOKEN);
  });
});
