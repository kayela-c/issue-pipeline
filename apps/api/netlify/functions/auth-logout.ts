import type { Config } from "@netlify/functions";
import { handleLogout } from "../../src/auth/handlers";
import { guarded } from "../../src/auth/loginDeps";

/** End the session. Needs no valid session, only a same-origin request. */
export default guarded("auth logout", handleLogout);

export const config: Config = { path: "/api/auth/logout", method: "POST" };
