import type { DraftDetail } from "@issue-pipeline/shared";
import type { ReconcileContext } from "../db/drafts";
import { ForgeError, type ForgeClient } from "../forge/types";
import { HttpError } from "../http";

/**
 * Stage 2: posting (docs/ARCHITECTURE.md section 7, no AI). Each function
 * takes the store it needs as a plain object of functions, so it can be unit
 * tested against fakes the same way pipeline/draft.ts is.
 */

const marker = (draftId: string) => `<!-- issue-pipeline:draft:${draftId} -->`;

/** The issue body: the draft's own body, a dependency line, then the hidden marker used to find it again. */
function buildIssueBody(draft: Pick<DraftDetail, "body" | "depends_on">, draftId: string): string {
  const numbers = draft.depends_on.map((d) => d.gitea_number).filter((n): n is number => n !== null);
  const depLine = numbers.length > 0 ? `\n\n**Depends on:** ${numbers.map((n) => `#${n}`).join(", ")}` : "";
  return `${draft.body}${depLine}\n\n${marker(draftId)}`;
}

function describePostFailure(err: unknown): string {
  if (err instanceof ForgeError) {
    if (err.status === 401) return "Gitea rejected the session token. Sign in again and retry.";
    if (err.status === 403) return "You don't have permission to create issues in this repository.";
    if (err.status === 404) return "The repository could not be found.";
    return `Posting to Gitea failed: ${err.message}.`;
  }
  return err instanceof Error ? err.message : String(err);
}

export interface PostStore {
  claimDraftForPosting(id: string, actorId: string): Promise<boolean>;
  getDraftDetail(id: string): Promise<DraftDetail | undefined>;
  markDraftPosted(input: {
    id: string;
    actorId: string;
    giteaNumber: number;
    giteaUrl: string;
    droppedLabels: string[];
  }): Promise<boolean>;
  markDraftFailed(input: { id: string; actorId: string; error: string }): Promise<boolean>;
  markDependencyLinked(draftId: string, dependsOnId: string): Promise<void>;
  recordLinkFailed(input: { draftId: string; actorId: string; dependsOnId: string; error: string }): Promise<void>;
}

export type PostOutcome =
  | { status: "posted"; gitea_number: number; gitea_url: string }
  | { status: "posting" }
  | { status: "failed"; error: string };

/** Why the atomic claim (docs/ARCHITECTURE.md section 4) refused to start posting. */
async function claimRefusal(store: Pick<PostStore, "getDraftDetail">, draftId: string): Promise<HttpError> {
  const detail = await store.getDraftDetail(draftId);
  if (!detail) return new HttpError("not_found", "Draft not found.");
  if (detail.status !== "approved") {
    return new HttpError("conflict", `Only approved drafts can be posted; this draft is ${detail.status}.`, {
      reason: "status",
      status: detail.status,
    });
  }
  const unposted = detail.depends_on.filter((d) => d.status !== "posted");
  if (unposted.length > 0) {
    return new HttpError(
      "conflict",
      `This draft depends on ${unposted.length} unposted ${unposted.length === 1 ? "draft" : "drafts"}: ${unposted
        .map((d) => d.title)
        .join(", ")}.`,
      { reason: "unposted_deps" },
    );
  }
  // Status was approved and every dependency posted when re-read, so someone else claimed it first.
  return new HttpError("conflict", "This draft is already being posted by someone else.", { reason: "claimed" });
}

/**
 * Post one approved draft as a Gitea issue. Failure while creating the issue
 * is ambiguous (timeout, connection reset, 5xx): Gitea may have created it
 * anyway, so the draft is left `posting` for reconcile to resolve instead of
 * guessing and risking a duplicate. Every other outcome is persisted before
 * this returns; a thrown error only ever means the claim itself was refused.
 */
export async function postDraft(draftId: string, actorId: string, forge: ForgeClient, store: PostStore): Promise<PostOutcome> {
  if (!(await store.claimDraftForPosting(draftId, actorId))) {
    throw await claimRefusal(store, draftId);
  }

  const detail = await store.getDraftDetail(draftId);
  if (!detail) throw new HttpError("not_found", "Draft not found.");

  let labelIds: number[];
  let droppedLabels: string[];
  try {
    const labels = await forge.listLabels(detail.repo.owner, detail.repo.name);
    const byName = new Map(labels.map((l) => [l.name, l.id]));
    labelIds = detail.labels.map((name) => byName.get(name)).filter((id): id is number => id !== undefined);
    droppedLabels = detail.labels.filter((name) => !byName.has(name));
  } catch (err) {
    const error = describePostFailure(err);
    await store.markDraftFailed({ id: draftId, actorId, error });
    return { status: "failed", error };
  }

  let created: { number: number; url: string };
  try {
    created = await forge.createIssue(detail.repo.owner, detail.repo.name, {
      title: detail.title,
      body: buildIssueBody(detail, draftId),
      labelIds,
    });
  } catch (err) {
    if (err instanceof ForgeError && err.retryable) {
      return { status: "posting" };
    }
    const error = describePostFailure(err);
    await store.markDraftFailed({ id: draftId, actorId, error });
    return { status: "failed", error };
  }

  await store.markDraftPosted({ id: draftId, actorId, giteaNumber: created.number, giteaUrl: created.url, droppedLabels });

  // A link failure does not undo the post; it is recorded for reconcile to retry.
  for (const dep of detail.depends_on) {
    if (dep.gitea_number === null) continue;
    try {
      await forge.addDependency(detail.repo.owner, detail.repo.name, created.number, dep.gitea_number);
      await store.markDependencyLinked(draftId, dep.id);
    } catch (err) {
      await store.recordLinkFailed({ draftId, actorId, dependsOnId: dep.id, error: describePostFailure(err) });
    }
  }

  return { status: "posted", gitea_number: created.number, gitea_url: created.url };
}

export interface ReconcileStore {
  getReconcileContext(id: string): Promise<ReconcileContext | undefined>;
  reconcileToPosted(input: { id: string; actorId: string; giteaNumber: number; giteaUrl: string }): Promise<boolean>;
  reconcileToApproved(input: { id: string; actorId: string }): Promise<boolean>;
  markDependencyLinked(draftId: string, dependsOnId: string): Promise<void>;
  recordLinkFailed(input: { draftId: string; actorId: string; dependsOnId: string; error: string }): Promise<void>;
  recordReconciledLinks(input: { id: string; actorId: string; linked: number; stillFailing: number }): Promise<void>;
}

export type ReconcileOutcome =
  | { outcome: "posted"; gitea_number: number }
  | { outcome: "approved" }
  | { outcome: "links"; linked: number; still_failing: number };

const RECONCILE_STALE_MINUTES = 5;

/**
 * Resolve a draft left `posting` for over five minutes (search Gitea for the
 * marker before deciding), or retry unlinked dependency links on a `posted`
 * draft (docs/ARCHITECTURE.md section 7).
 */
export async function reconcileDraft(draftId: string, actorId: string, forge: ForgeClient, store: ReconcileStore): Promise<ReconcileOutcome> {
  const ctx = await store.getReconcileContext(draftId);
  if (!ctx) throw new HttpError("not_found", "Draft not found.");

  if (ctx.status === "posting") {
    const staleSince = ctx.claimedAt ? Date.now() - new Date(ctx.claimedAt).getTime() : 0;
    if (staleSince < RECONCILE_STALE_MINUTES * 60_000) {
      throw new HttpError("conflict", `Only a posting stuck for over ${RECONCILE_STALE_MINUTES} minutes can be reconciled.`, {
        reason: "not_stale",
      });
    }
    if (!ctx.claimedByUsername) {
      throw new HttpError("internal_error", "This stuck draft has no claiming user on record.");
    }

    const since = new Date(new Date(ctx.claimedAt!).getTime() - 60_000);
    const found = (await forge.listIssuesCreatedBySince(ctx.repoOwner, ctx.repoName, ctx.claimedByUsername, since)).find((issue) =>
      issue.body.includes(marker(draftId)),
    );

    if (found) {
      if (!(await store.reconcileToPosted({ id: draftId, actorId, giteaNumber: found.number, giteaUrl: found.url }))) {
        throw new HttpError("conflict", "The draft changed while reconciling. Reload and try again.", { reason: "stale" });
      }
      return { outcome: "posted", gitea_number: found.number };
    }
    if (!(await store.reconcileToApproved({ id: draftId, actorId }))) {
      throw new HttpError("conflict", "The draft changed while reconciling. Reload and try again.", { reason: "stale" });
    }
    return { outcome: "approved" };
  }

  if (ctx.status === "posted" && ctx.giteaNumber !== null && ctx.unlinkedDeps.length > 0) {
    let linked = 0;
    for (const dep of ctx.unlinkedDeps) {
      try {
        await forge.addDependency(ctx.repoOwner, ctx.repoName, ctx.giteaNumber, dep.giteaNumber);
        await store.markDependencyLinked(draftId, dep.dependsOnId);
        linked++;
      } catch (err) {
        await store.recordLinkFailed({ draftId, actorId, dependsOnId: dep.dependsOnId, error: describePostFailure(err) });
      }
    }
    const stillFailing = ctx.unlinkedDeps.length - linked;
    await store.recordReconciledLinks({ id: draftId, actorId, linked, stillFailing });
    return { outcome: "links", linked, still_failing: stillFailing };
  }

  throw new HttpError("conflict", "Nothing to reconcile for this draft.", { reason: "not_stale" });
}
