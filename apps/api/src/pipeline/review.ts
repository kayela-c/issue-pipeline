import type { DraftStatus } from "@issue-pipeline/shared";
import { HttpError } from "../http";
import { findCycle } from "./graph";

/**
 * Review rules (docs/ARCHITECTURE.md section 4, "Draft state machine"). The
 * database enforces them with guarded writes; these functions validate input
 * up front and explain a refused write.
 */

export interface DraftState {
  status: DraftStatus;
  version: number;
}

/**
 * Why a guarded write changed nothing, given the draft as it is now.
 * `expected` is the status the change requires; `version` is what the client sent.
 */
export function refusal(current: DraftState | undefined, expected: DraftStatus, version?: number): HttpError {
  if (!current) return new HttpError("not_found", "Draft not found.");
  if (current.status !== expected) {
    const message =
      expected === "draft" && current.status === "approved"
        ? "This draft is approved, so it is read-only. Unapprove it to make changes."
        : expected === "approved"
          ? `Only approved drafts can be unapproved; this draft is ${current.status}.`
          : `This draft is ${current.status}, so it can no longer be changed.`;
    return new HttpError("conflict", message, { reason: "status", status: current.status, version: current.version });
  }
  if (version !== undefined && current.version !== version) {
    return new HttpError("conflict", "Edited by someone else. Reload to see the latest version.", {
      reason: "stale",
      status: current.status,
      version: current.version,
    });
  }
  // The row matched when re-read, so the write lost a race; treat it as stale.
  return new HttpError("conflict", "Edited by someone else. Reload to see the latest version.", {
    reason: "stale",
    status: current.status,
    version: current.version,
  });
}

/**
 * Check a proposed dependency set for one draft. Targets must exist, be in the
 * same repo, and not be the draft itself; the resulting graph must be acyclic.
 * Returns an error message, or undefined when the change is allowed.
 */
export function checkDependencies(input: {
  draftId: string;
  repoId: string;
  dependsOnIds: string[];
  /** The repo and id of each requested target that exists. */
  targets: Array<{ id: string; repoId: string }>;
  /** Every current edge in the repo, as [draft, depends on]. */
  edges: Array<[string, string]>;
  titles?: Map<string, string>;
}): string | undefined {
  const ids = [...new Set(input.dependsOnIds)];
  if (ids.includes(input.draftId)) return "A draft cannot depend on itself.";

  const found = new Map(input.targets.map((t) => [t.id, t.repoId]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) return `Dependency not found: ${missing.join(", ")}.`;
  const foreign = ids.filter((id) => found.get(id) !== input.repoId);
  if (foreign.length > 0) return "Dependencies must be drafts in the same repository.";

  const edges = input.edges.filter(([from]) => from !== input.draftId).concat(ids.map((id) => [input.draftId, id] as [string, string]));
  const nodes = new Set(edges.flat());
  const cycle = findCycle(nodes, edges);
  if (cycle) {
    const name = (id: string) => input.titles?.get(id) ?? id;
    return `That would create a dependency cycle: ${cycle.map(name).join(" -> ")}.`;
  }
  return undefined;
}
