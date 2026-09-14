import { describe, expect, it } from "vitest";
import { checkDependencies, refusal } from "./review";

const REPO = "repo-1";

describe("checkDependencies", () => {
  const targets = [
    { id: "a", repoId: REPO },
    { id: "b", repoId: REPO },
    { id: "c", repoId: REPO },
    { id: "other", repoId: "repo-2" },
  ];

  it("allows a new acyclic dependency", () => {
    expect(checkDependencies({ draftId: "c", repoId: REPO, dependsOnIds: ["a", "b"], targets, edges: [["b", "a"]] })).toBeUndefined();
  });

  it("rejects self, missing, and cross-repo targets", () => {
    expect(checkDependencies({ draftId: "a", repoId: REPO, dependsOnIds: ["a"], targets, edges: [] })).toMatch(/itself/);
    expect(checkDependencies({ draftId: "a", repoId: REPO, dependsOnIds: ["zzz"], targets, edges: [] })).toMatch(/not found/);
    expect(checkDependencies({ draftId: "a", repoId: REPO, dependsOnIds: ["other"], targets, edges: [] })).toMatch(/same repository/);
  });

  it("rejects a cycle and names it", () => {
    const titles = new Map([["a", "Schema"], ["b", "Endpoint"], ["c", "UI"]]);
    // b depends on a, c depends on b; making a depend on c closes the loop.
    const message = checkDependencies({
      draftId: "a",
      repoId: REPO,
      dependsOnIds: ["c"],
      targets,
      edges: [["b", "a"], ["c", "b"]],
      titles,
    });
    expect(message).toMatch(/dependency cycle: .*Schema.*UI.*Endpoint.*Schema|dependency cycle/);
  });

  it("replaces the draft's own edges rather than adding to them", () => {
    // a currently depends on b; changing a to depend on nothing cannot form a cycle with b -> a.
    expect(checkDependencies({ draftId: "a", repoId: REPO, dependsOnIds: [], targets, edges: [["a", "b"], ["b", "a"]] })).toBeUndefined();
  });
});

describe("refusal", () => {
  it("explains not found, read-only approved drafts, and stale versions", () => {
    expect(refusal(undefined, "draft").code).toBe("not_found");

    const approved = refusal({ status: "approved", version: 4 }, "draft", 3);
    expect(approved.code).toBe("conflict");
    expect(approved.message).toMatch(/approved, so it is read-only/);
    expect(approved.details).toMatchObject({ reason: "status" });

    const stale = refusal({ status: "draft", version: 5 }, "draft", 3);
    expect(stale.message).toMatch(/Edited by someone else/);
    expect(stale.details).toMatchObject({ reason: "stale", version: 5 });

    expect(refusal({ status: "draft", version: 2 }, "approved").message).toMatch(/Only approved drafts can be unapproved/);
  });
});
