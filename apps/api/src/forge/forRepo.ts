import { credentialKeysFromEnv, openCredential, type CredentialSlot } from "../crypto/credentials";
import { getDraftState } from "../db/drafts";
import { getIdentity } from "../db/identities";
import { getRepoById } from "../db/repos";
import type { Repo } from "../db/schema";
import { HttpError } from "../http";
import { GitHubForge } from "./github";
import type { ForgeClient } from "./types";

/** Where a user's GitHub access token is sealed (user_identities.access_token_enc). */
export const githubAccessTokenSlot = (userId: string): CredentialSlot => ({
  column: "user_identities.access_token",
  userId,
  subject: "github",
});

export interface ForgeForRepoDeps {
  /** The user's GitHub token with repo access, or undefined when they have none (never connected, or signed in before the repo scope). */
  loadGithubToken(userId: string): Promise<string | undefined>;
  createGithubForge(token: string): ForgeClient;
}

export const defaultForgeForRepoDeps: ForgeForRepoDeps = {
  async loadGithubToken(userId) {
    const identity = await getIdentity(userId, "github");
    return openCredential(identity?.accessTokenEnc, githubAccessTokenSlot(userId), credentialKeysFromEnv());
  },
  createGithubForge: (token) => new GitHubForge(token),
};

/** The caller's session Gitea client, plus who they are. */
export interface ForgeCaller {
  user: { id: string };
  forge: ForgeClient;
}

/**
 * The forge client to use for one repo, acting as the caller (Phase 9). Gitea
 * repos use the caller's session token as always; GitHub repos use the token
 * stored when they signed in or connected GitHub. Tokens are loaded on the
 * server by user id and never passed between functions.
 */
export async function forgeForRepo(
  caller: ForgeCaller,
  repo: Pick<Repo, "forge">,
  deps: ForgeForRepoDeps = defaultForgeForRepoDeps,
): Promise<ForgeClient> {
  if (repo.forge === "gitea") return caller.forge;
  if (repo.forge === "github") {
    const token = await deps.loadGithubToken(caller.user.id);
    if (!token) {
      throw new HttpError(
        "conflict",
        "Connect GitHub with repository access in Settings > Connections to use GitHub repositories.",
        { reason: "not_connected", forge: "github" },
      );
    }
    return deps.createGithubForge(token);
  }
  throw new HttpError("bad_request", `Repositories on ${repo.forge} are not supported yet.`);
}

/** The forge client for the repo a draft belongs to, or a 404 when the draft is gone. */
export async function forgeForDraft(caller: ForgeCaller, draftId: string): Promise<ForgeClient> {
  const state = await getDraftState(draftId);
  if (!state) throw new HttpError("not_found", "Draft not found.");
  return (await repoAndForge(caller, state.repoId)).forge;
}

/** A tracked repo and the forge client for it, or a 404 when it is not tracked. */
export async function repoAndForge(caller: ForgeCaller, repoId: string): Promise<{ repo: Repo; forge: ForgeClient }> {
  const repo = await getRepoById(repoId);
  if (!repo) throw new HttpError("not_found", "Repository not found.");
  return { repo, forge: await forgeForRepo(caller, repo) };
}
