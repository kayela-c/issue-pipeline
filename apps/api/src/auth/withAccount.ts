import type { Context } from "@netlify/functions";
import { getUserById, type User } from "../db/users";
import { apiError } from "../http";
import { passesCsrfCheck } from "./csrf";
import {
  SESSION_COOKIE,
  clearCookieHeader,
  keyringFromEnv,
  nowSeconds,
  readCookie,
  sessionMaxAgeSecondsFromEnv,
  sessionSchema,
  unseal,
  withCookies,
  type Keyring,
} from "./session";

export interface AccountContext {
  user: User;
}

export type AccountHandler = (req: Request, ctx: AccountContext, context: Context) => Promise<Response>;

export interface AccountDeps {
  keys(): Keyring;
  sessionMaxAgeSeconds(): number;
  now(): number;
  getUserById(id: string): Promise<User | undefined>;
}

export const defaultAccountDeps: AccountDeps = {
  keys: keyringFromEnv,
  sessionMaxAgeSeconds: sessionMaxAgeSecondsFromEnv,
  now: nowSeconds,
  getUserById,
};

/**
 * A lighter wrapper than withAuth: valid session -> valid account, with no
 * Gitea involved at all. Used only by /api/me, so a GitHub-only account
 * (decision 22, no Gitea link yet) can still learn who it is signed in as.
 * Every other endpoint stays behind withAuth, which does require Gitea and
 * re-checks GITEA_ALLOWED_ORG on every request -- this wrapper does neither,
 * so it grants no more than "here is the account", never repo or forge access.
 */
export function createWithAccount(deps: AccountDeps) {
  return (handler: AccountHandler) =>
    async (req: Request, context: Context): Promise<Response> => {
      if (!passesCsrfCheck(req)) {
        return apiError("forbidden", "Cross-site request rejected.");
      }
      const raw = readCookie(req, SESSION_COOKIE);
      if (!raw) {
        return apiError("unauthorized", "Not signed in.");
      }
      const session = unseal(SESSION_COOKIE, raw, deps.keys(), sessionSchema);
      if (!session) {
        return withCookies(apiError("unauthorized", "Your session is invalid. Sign in again."), [clearCookieHeader(SESSION_COOKIE)]);
      }
      if (deps.now() - session.session_started_at >= deps.sessionMaxAgeSeconds()) {
        return withCookies(apiError("unauthorized", "Your session has expired. Sign in again."), [clearCookieHeader(SESSION_COOKIE)]);
      }
      const user = await deps.getUserById(session.uid);
      if (!user) {
        return withCookies(apiError("unauthorized", "Your account no longer exists. Sign in again."), [clearCookieHeader(SESSION_COOKIE)]);
      }
      return handler(req, { user }, context);
    };
}

export const withAccount = createWithAccount(defaultAccountDeps);
