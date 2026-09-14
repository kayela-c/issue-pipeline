import type { Config } from "@netlify/functions";
import { withAuth } from "../../src/auth/withAuth";
import { getRepoById } from "../../src/db/repos";
import { HttpError, json, requireUuid } from "../../src/http";
import { triggerJob } from "../../src/jobs";

/** POST: start posting every ready draft in a repo, oldest first, in the background. */
export default withAuth(async (req, { giteaToken }, context) => {
  const repoId = requireUuid(context.params.id, "Repository");
  if (!(await getRepoById(repoId))) throw new HttpError("not_found", "Repository not found.");

  if (!(await triggerJob(req, "/internal/post-queue", { repo_id: repoId }, giteaToken))) {
    throw new HttpError("upstream_error", "The posting job could not be started. Try again.");
  }
  return json({}, 202);
});

export const config: Config = { path: "/api/repos/:id/post-queue", method: "POST" };
