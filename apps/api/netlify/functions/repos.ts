import type { Config } from "@netlify/functions";
import { trackRepoRequestSchema, type Repo, type RepoListResponse } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { listRepos, toRepoDto, trackRepo } from "../../src/db/repos";
import { forgeForRepo } from "../../src/forge/forRepo";
import { ForgeError } from "../../src/forge/types";
import { HttpError, apiError, json, readJson } from "../../src/http";

/** GET: tracked repos. POST {forge?, owner, name}: start tracking a repo the caller can read on that forge (default Gitea). */
export default withAuth(async (req, auth) => {
  const { user } = auth;
  if (req.method === "GET") {
    const body: RepoListResponse = { repos: (await listRepos()).map(toRepoDto) };
    return json(body);
  }

  const { forge: forgeName, owner, name } = await readJson(req, trackRepoRequestSchema);
  const forge = await forgeForRepo(auth, { forge: forgeName });
  let info;
  try {
    info = await forge.getRepo(owner, name);
  } catch (err) {
    if (err instanceof ForgeError && (err.status === 404 || err.status === 403)) {
      throw new HttpError("not_found", `${owner}/${name} does not exist or you cannot read it.`);
    }
    throw err;
  }
  if (!info.hasIssues) {
    return apiError("bad_request", `Issues are disabled on ${owner}/${name}.`);
  }
  if (info.empty) {
    return apiError("bad_request", `${owner}/${name} is empty.`);
  }

  const { repo, created } = await trackRepo({ forge: forgeName, owner, name, defaultBranch: info.defaultBranch, addedBy: user.id });
  const body: Repo = toRepoDto(repo);
  return json(body, created ? 201 : 200);
});

export const config: Config = { path: "/api/repos", method: ["GET", "POST"] };
