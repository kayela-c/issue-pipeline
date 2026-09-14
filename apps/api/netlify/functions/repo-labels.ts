import type { Config } from "@netlify/functions";
import type { RepoLabelsResponse } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { getRepoById } from "../../src/db/repos";
import { HttpError, json, requireUuid } from "../../src/http";

/** GET: the labels a tracked repo's issues can use (repo labels plus org labels), live from Gitea. */
export default withAuth(async (_req, { forge }, context) => {
  const repo = await getRepoById(requireUuid(context.params.id, "Repository"));
  if (!repo) throw new HttpError("not_found", "Repository not found.");
  const labels = await forge.listLabels(repo.owner, repo.name);
  const body: RepoLabelsResponse = { labels: labels.sort((a, b) => a.name.localeCompare(b.name)) };
  return json(body);
});

export const config: Config = { path: "/api/repos/:id/labels", method: "GET" };
