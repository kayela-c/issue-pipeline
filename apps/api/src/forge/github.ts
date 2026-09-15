import { z } from "zod";
import { GITHUB_TEMPLATE_DIRS } from "../pipeline/templates";
import {
  ForgeError,
  type CreateIssueInput,
  type CreatedIssue,
  type ForgeClient,
  type ForgeIssue,
  type ForgeLabel,
  type ForgeUser,
  type RepoInfo,
  type RepoRef,
  type TreeEntry,
} from "./types";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "issue-pipeline";
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const PER_PAGE = 100;
/** Up to 1,000 accessible repos for the picker; filtered by name in memory. */
const MAX_REPO_PAGES = 10;
const MAX_LABEL_PAGES = 10;
const MAX_ISSUE_PAGES = 10;

const userSchema = z.object({ id: z.number().int(), login: z.string().min(1), name: z.string().nullish() });

const repoSchema = z.object({
  name: z.string(),
  full_name: z.string(),
  description: z.string().nullish(),
  private: z.boolean(),
  archived: z.boolean().default(false),
  has_issues: z.boolean().default(true),
  default_branch: z.string().default(""),
  /** In KB; 0 for a repository with no commits. */
  size: z.number().default(0),
  owner: z.object({ login: z.string() }),
});

const branchSchema = z.object({ commit: z.object({ sha: z.string().min(1) }) });

const treeSchema = z.object({
  truncated: z.boolean().default(false),
  tree: z.array(z.object({ path: z.string(), type: z.string(), size: z.number().int().optional() })),
});

const labelsSchema = z.array(z.object({ id: z.number(), name: z.string() }));

const issueSchema = z.object({
  id: z.number(),
  number: z.number().int(),
  html_url: z.string(),
  body: z.string().nullish(),
  /** Present when the "issue" is actually a pull request. */
  pull_request: z.unknown().optional(),
});

type FetchLike = typeof fetch;

export interface GitHubForgeOptions {
  fetch?: FetchLike;
  /** Backoff before retry `attempt` (1-based). Overridable so tests don't sleep. */
  backoffMs?: (attempt: number) => number;
}

const defaultBackoff = (attempt: number) => 250 * 2 ** (attempt - 1) * (0.5 + Math.random());

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** GitHub signals an exhausted rate limit as 403 (or 429) with no requests remaining. */
const isRateLimited = (res: Response) =>
  res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");

/**
 * GitHub implementation of ForgeClient, bound to one user's OAuth App token
 * with the `repo` scope (Phase 9, decision 23). The token is held only for the
 * lifetime of this object and never included in an error message.
 */
export class GitHubForge implements ForgeClient {
  readonly label = "GitHub";
  readonly templateDirs = GITHUB_TEMPLATE_DIRS;
  private readonly fetchImpl: FetchLike;
  private readonly backoffMs: (attempt: number) => number;

  constructor(
    private readonly token: string,
    options: GitHubForgeOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.backoffMs = options.backoffMs ?? defaultBackoff;
  }

  async getCurrentUser(): Promise<ForgeUser> {
    const { id, login, name } = await this.getJson("/user", userSchema, "GET /user");
    return { id, username: login, fullName: name || undefined };
  }

  async isOrgMember(org: string, username: string): Promise<boolean> {
    const res = await this.request(`/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(username)}`, { redirect: "manual" });
    if (res.status === 204) return true;
    if ([302, 404].includes(res.status)) return false;
    throw new ForgeError(`org membership check returned ${res.status}`, res.status, false);
  }

  /** Repos the user owns, collaborates on, or can see through an org, most recently updated first. */
  async listAccessibleRepos(query = ""): Promise<RepoRef[]> {
    const needle = query.trim().toLowerCase();
    const matches: RepoRef[] = [];
    for (let page = 1; page <= MAX_REPO_PAGES; page++) {
      const params = new URLSearchParams({
        affiliation: "owner,collaborator,organization_member",
        sort: "updated",
        per_page: String(PER_PAGE),
        page: String(page),
      });
      const batch = await this.getJson(`/user/repos?${params}`, z.array(repoSchema), "GET /user/repos");
      for (const r of batch) {
        if (needle && !r.full_name.toLowerCase().includes(needle)) continue;
        matches.push({
          owner: r.owner.login,
          name: r.name,
          fullName: r.full_name,
          description: r.description ?? "",
          private: r.private,
          archived: r.archived,
          hasIssues: r.has_issues,
        });
      }
      if (batch.length < PER_PAGE || matches.length >= 50) break;
    }
    return matches.slice(0, 50);
  }

  async getRepo(owner: string, repo: string): Promise<RepoInfo> {
    const r = await this.getJson(this.repoPath(owner, repo), repoSchema, "GET repo");
    return { defaultBranch: r.default_branch, hasIssues: r.has_issues, empty: r.size === 0 };
  }

  async getBranchHead(owner: string, repo: string, branch: string): Promise<string> {
    const result = await this.getJson(`${this.repoPath(owner, repo)}/branches/${encodeURIComponent(branch)}`, branchSchema, "GET branch");
    return result.commit.sha;
  }

  async getTree(owner: string, repo: string, sha: string): Promise<TreeEntry[]> {
    const result = await this.getJson(
      `${this.repoPath(owner, repo)}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
      treeSchema,
      "GET tree",
    );
    // GitHub cannot page a recursive tree: past its limit (100,000 entries or 7 MB) it truncates.
    if (result.truncated) {
      throw new ForgeError("repository has more files than GitHub returns in one tree", 413, false);
    }
    return result.tree.filter((e) => e.type === "blob").map((e) => ({ path: e.path, size: e.size ?? 0 }));
  }

  async getRawFile(owner: string, repo: string, path: string, ref: string): Promise<string> {
    const res = await this.request(`${this.repoPath(owner, repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, {
      headers: { accept: "application/vnd.github.raw+json" },
    });
    if (res.status !== 200) {
      throw new ForgeError(`GET raw file returned ${res.status}`, res.status, false);
    }
    return res.text();
  }

  /** GitHub has no org-level labels: new repos copy the org defaults, so the repo's own list is complete. */
  async listLabels(owner: string, repo: string): Promise<ForgeLabel[]> {
    const all: ForgeLabel[] = [];
    for (let page = 1; page <= MAX_LABEL_PAGES; page++) {
      const batch = await this.getJson(`${this.repoPath(owner, repo)}/labels?per_page=${PER_PAGE}&page=${page}`, labelsSchema, "GET labels");
      all.push(...batch.map(({ id, name }) => ({ id, name })));
      if (batch.length < PER_PAGE) break;
    }
    return all;
  }

  async createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<CreatedIssue> {
    // A single attempt, as for Gitea: retrying an ambiguous POST risks a duplicate issue.
    const res = await this.requestOnce(`${this.repoPath(owner, repo)}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels.map((l) => l.name) }),
    });
    if (res.status !== 201) {
      throw new ForgeError(`create issue returned ${res.status}`, res.status, isRateLimited(res) || res.status >= 500);
    }
    const parsed = issueSchema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) {
      throw new ForgeError("create issue returned an unexpected body", 502, false);
    }
    return { number: parsed.data.number, url: parsed.data.html_url };
  }

  /** GitHub's issue dependencies API takes the blocking issue's database id, not its number. */
  async addDependency(owner: string, repo: string, issue: number, dependsOn: number): Promise<void> {
    const blocking = await this.getJson(`${this.repoPath(owner, repo)}/issues/${dependsOn}`, issueSchema, "GET blocking issue");
    const res = await this.request(`${this.repoPath(owner, repo)}/issues/${issue}/dependencies/blocked_by`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issue_id: blocking.id }),
    });
    if (res.status !== 201) {
      throw new ForgeError(`add dependency returned ${res.status}`, res.status, isRateLimited(res) || res.status >= 500);
    }
  }

  /**
   * GitHub's `since` filters on last update, not creation -- a superset of
   * "created since", which is fine for finding a marker. Pull requests share
   * the issues endpoint and are dropped.
   */
  async listIssuesCreatedBySince(owner: string, repo: string, username: string, since: Date): Promise<ForgeIssue[]> {
    const all: ForgeIssue[] = [];
    for (let page = 1; page <= MAX_ISSUE_PAGES; page++) {
      const params = new URLSearchParams({
        state: "all",
        creator: username,
        since: since.toISOString(),
        per_page: String(PER_PAGE),
        page: String(page),
      });
      const batch = await this.getJson(`${this.repoPath(owner, repo)}/issues?${params}`, z.array(issueSchema), "GET issues");
      for (const i of batch) {
        if (i.pull_request === undefined) all.push({ number: i.number, body: i.body ?? "", url: i.html_url });
      }
      if (batch.length < PER_PAGE) break;
    }
    return all;
  }

  private repoPath(owner: string, repo: string) {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
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

  private async requestOnce(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetchImpl(`${API}${path}`, {
        ...init,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "user-agent": USER_AGENT,
          "x-github-api-version": API_VERSION,
          ...init.headers,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.name : "unknown";
      throw new ForgeError(`GitHub request failed (${reason})`, 0, true);
    }
  }

  /** One API call with retries for rate limits, 5xx, and network failures. */
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let lastError: ForgeError | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, this.backoffMs(attempt - 1)));
      let res: Response;
      try {
        res = await this.requestOnce(path, init);
      } catch (err) {
        lastError = err as ForgeError;
        continue;
      }
      if (isRateLimited(res) || res.status >= 500) {
        lastError = new ForgeError(`GitHub returned ${res.status}`, res.status === 403 ? 429 : res.status, true);
        continue;
      }
      return res;
    }
    throw lastError ?? new ForgeError("GitHub request failed", 0, true);
  }
}
