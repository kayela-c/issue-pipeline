/**
 * Forge access behind an interface, so GitHub stays possible later without a
 * rewrite (docs/ARCHITECTURE.md section 5).
 *
 * Issue creation, dependency links, and issue search arrive with Phase 4.
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

export interface ForgeClient {
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
