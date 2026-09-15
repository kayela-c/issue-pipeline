import type { Config } from "@netlify/functions";
import { handleGithubCallback } from "../../src/auth/githubHandlers";
import { githubLoginDeps, guarded } from "../../src/auth/loginDeps";

/** Finish GitHub OAuth: link to the signed-in account, or sign in through a previously linked one. */
export default guarded("auth github callback", (req) => handleGithubCallback(req, githubLoginDeps));

export const config: Config = { path: "/api/auth/github/callback", method: "GET" };
