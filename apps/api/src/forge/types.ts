/**
 * Forge access behind an interface, so GitHub stays possible later without a
 * rewrite (docs/ARCHITECTURE.md section 5).
 */

export interface ForgeUser {
  id: number;
  username: string;
  fullName?: string;
}

export interface RepoRef {
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  archived: boolean;
  hasIssues: boolean;
}

export interface RepoInfo {
  defaultBranch: string;
  hasIssues: boolean;
  empty: boolean;
}

export interface TreeEntry {
  path: string;
  size: number;
}

export interface ForgeLabel {
  id: number;
  name: string;
}

export interface CreateIssueInput {
  title: string;
  body: string;
  /** Labels as the forge listed them; Gitea applies them by id, GitHub by name. */
  labels: ForgeLabel[];
}

export interface CreatedIssue {
  number: number;
  url: string;
}

export interface ForgeIssue {
  number: number;
  body: string;
  url: string;
}

export interface ForgeClient {
  /** "Gitea" or "GitHub", for messages a teammate reads. */
  readonly label: string;
  /** Directories this forge reads issue templates from, in its order of preference. */
  readonly templateDirs: readonly string[];
  getCurrentUser(): Promise<ForgeUser>;
  isOrgMember(org: string, username: string): Promise<boolean>;
  listAccessibleRepos(query?: string): Promise<RepoRef[]>;
  getRepo(owner: string, repo: string): Promise<RepoInfo>;
  /** Commit sha at the head of `branch`. */
  getBranchHead(owner: string, repo: string, branch: string): Promise<string>;
  /** Every file (blob) in the tree at `sha`, recursively. */
  getTree(owner: string, repo: string, sha: string): Promise<TreeEntry[]>;
  getRawFile(owner: string, repo: string, path: string, ref: string): Promise<string>;
  /** Repo labels plus, for org-owned repos, the org's labels. */
  listLabels(owner: string, repo: string): Promise<ForgeLabel[]>;
  /**
   * Create an issue, authored as the token's user. Made with a single attempt
   * (no retry): a timeout or 5xx here is ambiguous -- the issue may already
   * exist -- so the caller decides what to do instead of risking a duplicate.
   */
  createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<CreatedIssue>;
  /** Record that `issue` depends on `dependsOn` (both issue numbers). */
  addDependency(owner: string, repo: string, issue: number, dependsOn: number): Promise<void>;
  /** Issues created by `username` at or after `since`, for reconciling a stuck post. */
  listIssuesCreatedBySince(owner: string, repo: string, username: string, since: Date): Promise<ForgeIssue[]>;
}

/** A failed forge call. `retryable` marks 429/5xx/network failures. */
export class ForgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ForgeError";
  }
}
