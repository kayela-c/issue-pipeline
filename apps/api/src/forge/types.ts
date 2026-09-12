/**
 * Forge access behind an interface, so GitHub stays possible later without a
 * rewrite (docs/ARCHITECTURE.md section 5).
 *
 * Phase 1 needs only identity and the org gate; the repo, issue, and
 * dependency methods are added with the features that use them.
 */

export interface ForgeUser {
  id: number;
  username: string;
  fullName?: string;
}

export interface ForgeClient {
  getCurrentUser(): Promise<ForgeUser>;
  isOrgMember(org: string, username: string): Promise<boolean>;
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
