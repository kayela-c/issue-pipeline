import type { Config } from "@netlify/functions";
import type { RepoLabelsResponse } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { repoAndForge } from "../../src/forge/forRepo";
import { json, requireUuid } from "../../src/http";

/** GET: the labels a tracked repo's issues can use, live from its forge (Gitea adds org labels). */
export default withAuth(async (_req, auth, context) => {
  const { repo, forge } = await repoAndForge(auth, requireUuid(context.params.id, "Repository"));
  const labels = await forge.listLabels(repo.owner, repo.name);
  const body: RepoLabelsResponse = { labels: labels.sort((a, b) => a.name.localeCompare(b.name)) };
  return json(body);
});

export const config: Config = { path: "/api/repos/:id/labels", method: "GET" };
