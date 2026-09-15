import type { Config } from "@netlify/functions";
import { withAuth } from "../../src/auth/withAuth";
import { repoAndForge } from "../../src/forge/forRepo";
import { HttpError, json, requireUuid } from "../../src/http";
import { triggerJob } from "../../src/jobs";

/** POST: start posting every ready draft in a repo, oldest first, in the background. */
export default withAuth(async (req, auth, context) => {
  const repoId = requireUuid(context.params.id, "Repository");
  // Refuses up front (409 not_connected) rather than starting a job that cannot post.
  await repoAndForge(auth, repoId);

  if (!(await triggerJob(req, "/internal/post-queue", { repo_id: repoId }, auth.giteaToken))) {
    throw new HttpError("upstream_error", "The posting job could not be started. Try again.");
  }
  return json({}, 202);
});

export const config: Config = { path: "/api/repos/:id/post-queue", method: "POST" };
