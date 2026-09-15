import { credentialKeysFromEnv } from "../crypto/credentials";
import { findIdentityByForgeUser, setIdentityAccessToken, upsertIdentity, touchIdentityToken } from "../db/identities";
import { createUnlinkedUser, getUserById, linkGiteaToUser } from "../db/users";
import { apiError } from "../http";
import { exchangeGithubCode, fetchGithubUser, githubAllowedUsersFromEnv, githubOAuthConfigFromEnv } from "./github";
import type { GithubLoginDeps } from "./githubHandlers";
import type { LoginDeps } from "./handlers";
import { exchangeCode } from "./oauth";
import { defaultAuthDeps } from "./withAuth";

export const loginDeps: LoginDeps = {
  ...defaultAuthDeps,
  exchange: (cfg, params) => exchangeCode(cfg, params),
  linkGitea: (userId, forgeUser) => linkGiteaToUser(userId, forgeUser),
};

export const githubLoginDeps: GithubLoginDeps = {
  ...loginDeps,
  githubConfig: githubOAuthConfigFromEnv,
  allowedGithubUsers: githubAllowedUsersFromEnv,
  exchangeGithub: (cfg, params) => exchangeGithubCode(cfg, params),
  fetchGithubUser: (token) => fetchGithubUser(token),
  credentialKeys: credentialKeysFromEnv,
  findGithubIdentity: async (forgeUserId) => {
    const row = await findIdentityByForgeUser("github", forgeUserId);
    return row && { userId: row.userId, giteaRefreshTokenEnc: row.giteaRefreshTokenEnc };
  },
  linkGithubIdentity: (input) => upsertIdentity({ ...input, forge: "github" }),
  touchGithubIdentityToken: (userId, giteaRefreshTokenEnc) => touchIdentityToken(userId, "github", giteaRefreshTokenEnc),
  saveGithubAccessToken: (userId, accessTokenEnc) => setIdentityAccessToken(userId, "github", accessTokenEnc),
  createAccount: (input) => createUnlinkedUser(input),
  getAccountUser: (userId) => getUserById(userId),
};

/**
 * Wrap an auth route so a configuration error (a missing env var, a bad
 * SESSION_SECRET) becomes a clean 500 instead of an unhandled rejection.
 */
export function guarded(name: string, handler: (req: Request) => Response | Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      return await handler(req);
    } catch (err) {
      console.error(`${name} failed`, { message: err instanceof Error ? err.message : String(err) });
      return apiError("internal_error", "Sign-in is not configured correctly.");
    }
  };
}
