import type { Config } from "@netlify/functions";
import { handleGithubLogin } from "../../src/auth/githubHandlers";
import { githubLoginDeps, guarded } from "../../src/auth/loginDeps";

/** Start GitHub OAuth. Works signed out (sign in with a linked account) or signed in (link one). */
export default guarded("auth github login", (req) => handleGithubLogin(req, githubLoginDeps));

export const config: Config = { path: "/api/auth/github/login", method: "GET" };
