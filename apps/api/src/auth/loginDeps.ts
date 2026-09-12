import { apiError } from "../http";
import type { LoginDeps } from "./handlers";
import { exchangeCode } from "./oauth";
import { defaultAuthDeps } from "./withAuth";

export const loginDeps: LoginDeps = {
  ...defaultAuthDeps,
  exchange: (cfg, params) => exchangeCode(cfg, params),
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
