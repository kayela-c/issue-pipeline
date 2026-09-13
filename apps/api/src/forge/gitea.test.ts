import { describe, expect, it, vi } from "vitest";
import { GiteaForge } from "./gitea";
import { ForgeError } from "./types";

const BASE = "https://git.example.com/";
const TOKEN = "gta_secret_token_value";

function forgeWith(responses: Array<Response | Error>) {
  const fetch = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    return next;
  });
  const forge = new GiteaForge(BASE, TOKEN, { fetch, backoffMs: () => 0 });
  return { forge, fetch };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("GiteaForge", () => {
  it("maps /user and sends the token as a bearer header", async () => {
    const { forge, fetch } = forgeWith([jsonResponse({ id: 3, login: "kayela", full_name: "" })]);
    await expect(forge.getCurrentUser()).resolves.toEqual({ id: 3, username: "kayela", fullName: undefined });

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://git.example.com/api/v1/user");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("throws a non-retryable ForgeError for a rejected token", async () => {
    const { forge, fetch } = forgeWith([jsonResponse({ message: "unauthorized" }, 401)]);
    const err = await forge.getCurrentUser().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect(err).toMatchObject({ status: 401, retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx and network errors, then succeeds", async () => {
    const { forge, fetch } = forgeWith([
      new Response("", { status: 502 }),
      new TypeError("fetch failed"),
      jsonResponse({ id: 3, login: "kayela" }),
    ]);
    await expect(forge.getCurrentUser()).resolves.toMatchObject({ username: "kayela" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("gives up after three retryable failures", async () => {
    const { forge } = forgeWith([
      new Response("", { status: 503 }),
      new Response("", { status: 429 }),
      new Response("", { status: 500 }),
    ]);
    await expect(forge.getCurrentUser()).rejects.toMatchObject({ status: 500, retryable: true });
  });

  it("pages a recursive tree until Gitea stops reporting truncation, keeping only blobs", async () => {
    const { forge, fetch } = forgeWith([
      jsonResponse({ truncated: true, tree: [{ path: "src", type: "tree", size: 0 }, { path: "src/a.ts", type: "blob", size: 5 }] }),
      jsonResponse({ truncated: false, tree: [{ path: "lib", type: "commit" }, { path: "README.md", type: "blob", size: 9 }] }),
    ]);
    await expect(forge.getTree("o", "r", "abc")).resolves.toEqual([
      { path: "src/a.ts", size: 5 },
      { path: "README.md", size: 9 },
    ]);
    const urls = fetch.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls[0]).toBe("https://git.example.com/api/v1/repos/o/r/git/trees/abc?recursive=true&page=1&per_page=1000");
    expect(urls[1]).toContain("page=2");
  });

  it("encodes raw file paths per segment and pins the ref", async () => {
    const { forge, fetch } = forgeWith([new Response("hello", { status: 200 })]);
    await expect(forge.getRawFile("o", "r", "src/my file#1.ts", "sha1")).resolves.toBe("hello");
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://git.example.com/api/v1/repos/o/r/raw/src/my%20file%231.ts?ref=sha1",
    );
  });

  it("merges org labels under repo labels and tolerates user-owned repos", async () => {
    const { forge } = forgeWith([
      jsonResponse([{ id: 1, name: "bug" }]),
      jsonResponse([{ id: 9, name: "bug" }, { id: 10, name: "org-only" }]),
    ]);
    await expect(forge.listLabels("TrueRoster", "app")).resolves.toEqual([
      { id: 1, name: "bug" },
      { id: 10, name: "org-only" },
    ]);

    const user = forgeWith([jsonResponse([{ id: 1, name: "bug" }]), jsonResponse({ message: "not found" }, 404)]);
    await expect(user.forge.listLabels("kayela", "app")).resolves.toEqual([{ id: 1, name: "bug" }]);
  });

  it("treats only a direct 204 as org membership", async () => {
    for (const [status, member] of [[204, true], [302, false], [404, false], [403, false]] as const) {
      const { forge, fetch } = forgeWith([new Response(null, { status })]);
      await expect(forge.isOrgMember("True Roster", "kay")).resolves.toBe(member);
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://git.example.com/api/v1/orgs/True%20Roster/members/kay");
      expect(init.redirect).toBe("manual");
    }
  });
});
