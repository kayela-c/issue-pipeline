import type { Config } from "@netlify/functions";
import { handleLogin } from "../../src/auth/handlers";
import { guarded, loginDeps } from "../../src/auth/loginDeps";

/** Start the Gitea OAuth flow. Unauthenticated by design. */
export default guarded("auth login", (req) => handleLogin(req, loginDeps));

export const config: Config = { path: "/api/auth/login", method: "GET" };
