import type { Context } from "@netlify/functions";
import { upsertUser, type User } from "../db/users";
import { GiteaForge } from "../forge/gitea";
import { ForgeError, type ForgeClient, type ForgeUser } from "../forge/types";
import { HttpError, apiError } from "../http";
import { passesCsrfCheck } from "./csrf";
import { oauthConfigFromEnv, refreshTokens, type OAuthConfig, type TokenResult } from "./oauth";
import {
  SESSION_COOKIE,
  clearCookieHeader,
  keyringFromEnv,
  nowSeconds,
  readCookie,
  sessionCookieHeader,
  sessionMaxAgeSecondsFromEnv,
  sessionSchema,
  unseal,
  withCookies,
  type Keyring,
  type Session,
} from "./session";

export interface AuthContext {
  user: User;
  /** The caller's Gitea token. Request-scoped: never persist or log it. */
  giteaToken: string;
  /** A forge client bound to the caller's token. */
  forge: ForgeClient;
}

export type AuthedHandler = (
  req: Request,
  auth: AuthContext,
  context: Context,
) => Promise<Response>;

export interface AuthDeps {
  createForge(token: string): ForgeClient;
  upsertUser(forgeUser: ForgeUser): Promise<User>;
  allowedOrg(): string;
  keys(): Keyring;
  oauth(): OAuthConfig;
  refresh(cfg: OAuthConfig, refreshToken: string): Promise<TokenResult>;
  sessionMaxAgeSeconds(): number;
  now(): number;
}

/**
 * Refresh when the access token has less than this left. Any token handed to a
 * background job therefore outlives the job's 15-minute limit.
 */
export const REFRESH_MARGIN_SECONDS = 20 * 60;

// Tokens are JWTs of a few hundred characters; anything far larger is junk.
const MAX_TOKEN_LENGTH = 4096;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export const defaultAuthDeps: AuthDeps = {
  createForge: (token) => new GiteaForge(requireEnv("GITEA_BASE_URL"), token),
  upsertUser,
  allowedOrg: () => requireEnv("GITEA_ALLOWED_ORG"),
  keys: keyringFromEnv,
  oauth: oauthConfigFromEnv,
  refresh: (cfg, refreshToken) => refreshTokens(cfg, refreshToken),
  sessionMaxAgeSeconds: sessionMaxAgeSecondsFromEnv,
  now: nowSeconds,
};

/** `undefined` when there is no Authorization header; `null` when it is malformed. */
function bearerToken(req: Request): string | null | undefined {
  const header = req.headers.get("authorization");
  if (header === null) return undefined;
  const token = header.match(/^Bearer\s+(\S+)$/i)?.[1];
  return token && token.length <= MAX_TOKEN_LENGTH ? token : null;
}

/** Scrub the caller's token, and anything shaped like a bearer header, from log text. */
export function redact(text: string, ...secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

export function createWithAuth(deps: AuthDeps) {
  return (handler: AuthedHandler) =>
    async (req: Request, context: Context): Promise<Response> => {
      const path = new URL(req.url).pathname;
      const cookies: string[] = [];
      const signedOut = (message: string) =>
        withCookies(apiError("unauthorized", message), [clearCookieHeader(SESSION_COOKIE)]);

      let session: Session | undefined;
      let token: string;

      try {
        const bearer = bearerToken(req);
        if (bearer === null) {
          return apiError("unauthorized", "Malformed bearer token.");
        }

        if (bearer) {
          // Scripts, tests, and background jobs. Not an ambient credential,
          // so no CSRF check and no cookies.
          token = bearer;
        } else {
          if (!passesCsrfCheck(req)) {
            return apiError("forbidden", "Cross-site request rejected.");
          }
          const raw = readCookie(req, SESSION_COOKIE);
          if (!raw) {
            return apiError("unauthorized", "Not signed in.");
          }
          const keys = deps.keys();
          session = unseal(SESSION_COOKIE, raw, keys, sessionSchema);
          if (!session) {
            return signedOut("Your session is invalid. Sign in again.");
          }

          const now = deps.now();
          const maxAge = deps.sessionMaxAgeSeconds();
          if (now - session.session_started_at >= maxAge) {
            return signedOut("Your session has expired. Sign in again.");
          }

          if (session.access_expires_at - now <= REFRESH_MARGIN_SECONDS) {
            const result = await deps.refresh(deps.oauth(), session.refresh_token);
            if (!result.ok && result.kind === "rejected") {
              return signedOut("Your session has ended. Sign in again.");
            }
            if (!result.ok) {
              console.error("token refresh failed", { path, message: result.message });
              return apiError("upstream_error", "Gitea is unavailable. Try again shortly.");
            }
            session = {
              ...session,
              access_token: result.token.access_token,
              // Gitea rotates refresh tokens; keep the old one only if the
              // response somehow omits a new one.
              refresh_token: result.token.refresh_token || session.refresh_token,
              access_expires_at: now + result.token.expires_in,
            };
            cookies.push(sessionCookieHeader(session, keys, maxAge, now));
          }
          token = session.access_token;
        }
      } catch (err) {
        return internalError(err, path);
      }

      try {
        const forge = deps.createForge(token);

        let forgeUser: ForgeUser;
        try {
          forgeUser = await forge.getCurrentUser();
        } catch (err) {
          if (err instanceof ForgeError && (err.status === 401 || err.status === 403)) {
            return session
              ? signedOut("Gitea rejected your session. Sign in again.")
              : apiError("unauthorized", "Gitea rejected the token.");
          }
          throw err;
        }
        if (session && forgeUser.id !== session.gitea_id) {
          return signedOut("Your session does not match your Gitea account. Sign in again.");
        }

        const org = deps.allowedOrg();
        if (!(await forge.isOrgMember(org, forgeUser.username))) {
          return withCookies(
            apiError("forbidden", `You must be a member of the ${org} organization.`),
            cookies,
          );
        }

        const user = await deps.upsertUser(forgeUser);
        const res = await handler(req, { user, giteaToken: token, forge }, context);
        return withCookies(res, cookies);
      } catch (err) {
        if (err instanceof HttpError) {
          return withCookies(err.toResponse(), cookies);
        }
        if (err instanceof ForgeError) {
          console.error("forge error", { path, status: err.status, message: redact(err.message, token) });
          return withCookies(apiError("upstream_error", "Gitea is unavailable. Try again shortly."), cookies);
        }
        return withCookies(internalError(err, path, token), cookies);
      }
    };
}

function internalError(err: unknown, path: string, ...secrets: string[]): Response {
  const message = err instanceof Error ? err.message : String(err);
  // Log the path, never headers or cookies: both carry credentials.
  console.error("unhandled error", { path, message: redact(message, ...secrets) });
  return apiError("internal_error", "Something went wrong.");
}

/**
 * Wrap a handler so it runs only for a member of GITEA_ALLOWED_ORG, identified
 * by the session cookie or a bearer token. See docs/ARCHITECTURE.md section 5.
 */
export const withAuth = createWithAuth(defaultAuthDeps);
