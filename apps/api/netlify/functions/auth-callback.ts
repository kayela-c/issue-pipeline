import type { Config } from "@netlify/functions";
import { handleCallback } from "../../src/auth/handlers";
import { guarded, loginDeps } from "../../src/auth/loginDeps";

/** Finish the Gitea OAuth flow and start a session. Unauthenticated by design. */
export default guarded("auth callback", (req) => handleCallback(req, loginDeps));

export const config: Config = { path: "/api/auth/callback", method: "GET" };
