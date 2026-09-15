import { TEMPLATE_DIRS } from "../pipeline/templates";
import type { ForgeClient } from "./types";

/** A ForgeClient for tests: every method throws unless overridden. */
export function fakeForge(overrides: Partial<ForgeClient> = {}): ForgeClient {
  const missing = (name: string) => () => {
    throw new Error(`fakeForge.${name} was called but not stubbed`);
  };
  return {
    label: "Gitea",
    templateDirs: TEMPLATE_DIRS,
    getCurrentUser: missing("getCurrentUser"),
    isOrgMember: missing("isOrgMember"),
    listAccessibleRepos: missing("listAccessibleRepos"),
    getRepo: missing("getRepo"),
    getBranchHead: missing("getBranchHead"),
    getTree: missing("getTree"),
    getRawFile: missing("getRawFile"),
    listLabels: missing("listLabels"),
    createIssue: missing("createIssue"),
    addDependency: missing("addDependency"),
    listIssuesCreatedBySince: missing("listIssuesCreatedBySince"),
    ...overrides,
  };
}
