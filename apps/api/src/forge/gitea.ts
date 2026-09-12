import { z } from "zod";
import { ForgeError, type ForgeClient, type ForgeUser } from "./types";

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;

const giteaUserSchema = z.object({
  id: z.number().int(),
  login: z.string().min(1),
  full_name: z.string().optional(),
});

type FetchLike = typeof fetch;

export interface GiteaForgeOptions {
  fetch?: FetchLike;
  /** Backoff before retry `attempt` (1-based). Overridable so tests don't sleep. */
  backoffMs?: (attempt: number) => number;
}

/** Jittered exponential backoff: ~250 ms, ~500 ms, ... */
const defaultBackoff = (attempt: number) =>
  250 * 2 ** (attempt - 1) * (0.5 + Math.random());

/**
 * Gitea implementation of ForgeClient, bound to one user's token.
 *
 * The token is held only for the lifetime of this object (one request) and is
 * never included in an error message.
 */
export class GiteaForge implements ForgeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly backoffMs: (attempt: number) => number;

  constructor(
    baseUrl: string,
    private readonly token: string,
    options: GiteaForgeOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.backoffMs = options.backoffMs ?? defaultBackoff;
  }

  async getCurrentUser(): Promise<ForgeUser> {
    const res = await this.request("/api/v1/user");
    if (res.status !== 200) {
      throw new ForgeError(`GET /user returned ${res.status}`, res.status, false);
    }
    const parsed = giteaUserSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new ForgeError("GET /user returned an unexpected body", 502, false);
    }
    const { id, login, full_name } = parsed.data;
    return { id, username: login, fullName: full_name || undefined };
  }

  async isOrgMember(org: string, username: string): Promise<boolean> {
    const path = `/api/v1/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(username)}`;
    // Redirects are not followed: Gitea redirects non-members to the
    // public_members endpoint, and only a direct 204 counts as membership.
    const res = await this.request(path, { redirect: "manual" });
    if (res.status === 204) return true;
    if ([302, 403, 404].includes(res.status)) return false;
    throw new ForgeError(`org membership check returned ${res.status}`, res.status, false);
  }

  /** One API call with retries for 429, 5xx, and network failures. */
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let lastError: ForgeError | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await new Promise((r) => setTimeout(r, this.backoffMs(attempt - 1)));
      }

      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.token}`,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.name : "unknown";
        lastError = new ForgeError(`Gitea request failed (${reason})`, 0, true);
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        lastError = new ForgeError(`Gitea returned ${res.status}`, res.status, true);
        continue;
      }
      return res;
    }

    throw lastError ?? new ForgeError("Gitea request failed", 0, true);
  }
}
