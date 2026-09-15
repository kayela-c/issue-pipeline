import type { Config } from "@netlify/functions";
import type { GiteaRepoListResponse } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { forgeForRepo } from "../../src/forge/forRepo";
import { json } from "../../src/http";

/**
 * Repos the signed-in user can see on GitHub, for the "track a repo" picker
 * (Phase 9). 409 `not_connected` when they have no GitHub token with repo access.
 */
export default withAuth(async (req, auth) => {
  const query = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 100);
  const forge = await forgeForRepo(auth, { forge: "github" });
  const repos = await forge.listAccessibleRepos(query);
  const body: GiteaRepoListResponse = {
    repos: repos.map((r) => ({
      owner: r.owner,
      name: r.name,
      full_name: r.fullName,
      description: r.description,
      private: r.private,
      archived: r.archived,
      has_issues: r.hasIssues,
    })),
  };
  return json(body);
});

export const config: Config = { path: "/api/github/repos", method: "GET" };
