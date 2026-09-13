import { z } from "zod";
import {
  ForgeError,
  type ForgeClient,
  type ForgeLabel,
  type ForgeUser,
  type RepoInfo,
  type RepoRef,
  type TreeEntry,
} from "./types";

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
/** Gitea's default `[api] MAX_RESPONSE_ITEMS`. */
const PAGE_LIMIT = 50;
/** Gitea's default `[api] DEFAULT_GIT_TREES_PER_PAGE`, and its maximum. */
const TREE_PAGE_SIZE = 1000;
/** 100k files. A repo past this is not something a prompt can use anyway. */
const MAX_TREE_PAGES = 100;
const MAX_LABEL_PAGES = 20;

const giteaUserSchema = z.object({
  id: z.number().int(),
  login: z.string().min(1),
  full_name: z.string().optional(),
});

const giteaRepoSchema = z.object({
  name: z.string(),
  full_name: z.string(),
  description: z.string().nullish(),
  private: z.boolean(),
  archived: z.boolean().default(false),
  has_issues: z.boolean().default(true),
  empty: z.boolean().default(false),
  default_branch: z.string().default(""),
  owner: z.object({ login: z.string() }),
});

const searchResultsSchema = z.object({ ok: z.boolean(), data: z.array(giteaRepoSchema) });

const branchSchema = z.object({ commit: z.object({ id: z.string().min(1) }) });

const treeResponseSchema = z.object({
  truncated: z.boolean(),
  tree: z
    .array(z.object({ path: z.string(), type: z.string(), size: z.number().int().default(0) }))
    .nullish(),
});

const labelsSchema = z.array(z.object({ id: z.number().int(), name: z.string() }));

type FetchLike = typeof fetch;

export interface GiteaForgeOptions {
  fetch?: FetchLike;
  /** Backoff before retry `attempt` (1-based). Overridable so tests don't sleep. */
  backoffMs?: (attempt: number) => number;
}

/** Jittered exponential backoff: ~250 ms, ~500 ms, ... */
const defaultBackoff = (attempt: number) => 250 * 2 ** (attempt - 1) * (0.5 + Math.random());

/** Encode each segment of a repo file path, keeping the slashes. */
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

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
    const { id, login, full_name } = await this.getJson("/api/v1/user", giteaUserSchema, "GET /user");
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

  async listAccessibleRepos(query = ""): Promise<RepoRef[]> {
    const params = new URLSearchParams({ q: query, limit: String(PAGE_LIMIT), sort: "updated", order: "desc" });
    const results = await this.getJson(`/api/v1/repos/search?${params}`, searchResultsSchema, "repo search");
    return results.data.map((r) => ({
      owner: r.owner.login,
      name: r.name,
      fullName: r.full_name,
      description: r.description ?? "",
      private: r.private,
      archived: r.archived,
      hasIssues: r.has_issues,
    }));
  }

  async getRepo(owner: string, repo: string): Promise<RepoInfo> {
    const r = await this.getJson(this.repoPath(owner, repo), giteaRepoSchema, "GET repo");
    return { defaultBranch: r.default_branch, hasIssues: r.has_issues, empty: r.empty };
  }

  async getBranchHead(owner: string, repo: string, branch: string): Promise<string> {
    const path = `${this.repoPath(owner, repo)}/branches/${encodeURIComponent(branch)}`;
    const result = await this.getJson(path, branchSchema, "GET branch");
    return result.commit.id;
  }

  async getTree(owner: string, repo: string, sha: string): Promise<TreeEntry[]> {
    const entries: TreeEntry[] = [];
    for (let page = 1; page <= MAX_TREE_PAGES; page++) {
      const params = new URLSearchParams({ recursive: "true", page: String(page), per_page: String(TREE_PAGE_SIZE) });
      const path = `${this.repoPath(owner, repo)}/git/trees/${encodeURIComponent(sha)}?${params}`;
      const result = await this.getJson(path, treeResponseSchema, "GET tree");
      for (const entry of result.tree ?? []) {
        // "tree" entries are directories and "commit" entries are submodules.
        if (entry.type === "blob") entries.push({ path: entry.path, size: entry.size });
      }
      // Gitea sets `truncated` while entries remain beyond this page.
      if (!result.truncated) return entries;
    }
    throw new ForgeError(`repository has more than ${MAX_TREE_PAGES * TREE_PAGE_SIZE} files`, 413, false);
  }

  async getRawFile(owner: string, repo: string, path: string, ref: string): Promise<string> {
    const url = `${this.repoPath(owner, repo)}/raw/${encodePath(path)}?ref=${encodeURIComponent(ref)}`;
    const res = await this.request(url);
    if (res.status !== 200) {
      throw new ForgeError(`GET raw file returned ${res.status}`, res.status, false);
    }
    return res.text();
  }

  async listLabels(owner: string, repo: string): Promise<ForgeLabel[]> {
    const repoLabels = await this.paged(`${this.repoPath(owner, repo)}/labels`, "GET repo labels");
    let orgLabels: ForgeLabel[] = [];
    try {
      orgLabels = await this.paged(`/api/v1/orgs/${encodeURIComponent(owner)}/labels`, "GET org labels");
    } catch (err) {
      // A user-owned repo has no org labels.
      if (!(err instanceof ForgeError && err.status === 404)) throw err;
    }
    // A repo label shadows an org label of the same name.
    const byName = new Map<string, ForgeLabel>();
    for (const label of [...orgLabels, ...repoLabels]) byName.set(label.name, label);
    return [...byName.values()];
  }

  private repoPath(owner: string, repo: string) {
    return `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private async paged(path: string, what: string): Promise<ForgeLabel[]> {
    const all: ForgeLabel[] = [];
    for (let page = 1; page <= MAX_LABEL_PAGES; page++) {
      const batch = await this.getJson(`${path}?page=${page}&limit=${PAGE_LIMIT}`, labelsSchema, what);
      all.push(...batch.map(({ id, name }) => ({ id, name })));
      if (batch.length < PAGE_LIMIT) break;
    }
    return all;
  }

  private async getJson<T>(path: string, schema: z.ZodType<T>, what: string): Promise<T> {
    const res = await this.request(path);
    if (res.status !== 200) {
      throw new ForgeError(`${what} returned ${res.status}`, res.status, false);
    }
    const parsed = schema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) {
      throw new ForgeError(`${what} returned an unexpected body`, 502, false);
    }
    return parsed.data;
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
