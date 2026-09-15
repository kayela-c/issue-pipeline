import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../http";
import { fakeForge } from "./fake";
import { forgeForRepo, type ForgeForRepoDeps } from "./forRepo";

const giteaForge = fakeForge();
const githubForge = fakeForge();
const caller = { user: { id: "00000000-0000-4000-8000-000000000001" }, forge: giteaForge };

function deps(token: string | undefined) {
  return {
    loadGithubToken: vi.fn(async () => token),
    createGithubForge: vi.fn(() => githubForge),
  } satisfies ForgeForRepoDeps;
}

describe("forgeForRepo", () => {
  it("uses the caller's session forge for a Gitea repo, without loading any stored token", async () => {
    const d = deps("gho_x");
    await expect(forgeForRepo(caller, { forge: "gitea" }, d)).resolves.toBe(giteaForge);
    expect(d.loadGithubToken).not.toHaveBeenCalled();
  });

  it("builds a GitHub client from the caller's own stored token for a GitHub repo", async () => {
    const d = deps("gho_x");
    await expect(forgeForRepo(caller, { forge: "github" }, d)).resolves.toBe(githubForge);
    expect(d.loadGithubToken).toHaveBeenCalledWith(caller.user.id);
    expect(d.createGithubForge).toHaveBeenCalledWith("gho_x");
  });

  it("answers 409 not_connected when the caller has no GitHub token with repo access", async () => {
    const err = await forgeForRepo(caller, { forge: "github" }, deps(undefined)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ code: "conflict", details: { reason: "not_connected", forge: "github" } });
  });

  it("refuses a forge with no client yet", async () => {
    await expect(forgeForRepo(caller, { forge: "gitlab" }, deps("x"))).rejects.toMatchObject({ code: "bad_request" });
  });
});
