import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DRAFT_TITLE_MAX, type DraftDetail, type DraftEventItem } from "@issue-pipeline/shared";
import { useEffect, useMemo, useState } from "react";
import { Markdown } from "../components/Markdown";
import {
  ApiError,
  approveDraft,
  deleteDraft,
  getDraft,
  getRepoLabels,
  listDrafts,
  postDraft,
  reconcileDraft,
  retryDraft,
  unapproveDraft,
  updateDraft,
  updateDraftDeps,
} from "../lib/api";
import { linkHandler, navigate } from "../lib/router";
import { DRAFT_STATUS_LABEL } from "./Board";

interface Form {
  title: string;
  body: string;
  labels: string[];
  dependsOn: string[];
}

const formOf = (d: DraftDetail): Form => ({
  title: d.title,
  body: d.body,
  labels: [...d.labels].sort(),
  dependsOn: d.depends_on.map((x) => x.id).sort(),
});

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function describeEvent(e: DraftEventItem): string {
  const detail = (e.detail ?? {}) as { fields?: string[]; depends_on_ids?: string[]; run_id?: string };
  switch (e.event) {
    case "created":
      return "drafted from notes";
    case "edited":
      return `edited ${detail.fields?.join(", ") ?? ""}`.trim();
    case "deps_changed":
      return `set ${detail.depends_on_ids?.length ?? 0} ${detail.depends_on_ids?.length === 1 ? "dependency" : "dependencies"}`;
    default:
      return e.event.replace("_", " ");
  }
}

const isStale = (err: unknown) =>
  err instanceof ApiError && err.code === "conflict" && (err.details as { reason?: string } | undefined)?.reason === "stale";

/** Review one draft: edit while it is a draft, then approve; unapprove to edit again. */
export function DraftEditor({ draftId }: { draftId: string }) {
  const queryClient = useQueryClient();
  const draft = useQuery({ queryKey: ["draft", draftId], queryFn: () => getDraft(draftId), refetchInterval: 15_000 });
  const d = draft.data;

  const labels = useQuery({
    queryKey: ["repo-labels", d?.repo_id],
    queryFn: () => getRepoLabels(d!.repo_id),
    enabled: !!d && d.status === "draft",
    staleTime: 60_000,
  });
  const siblings = useQuery({
    queryKey: ["drafts", d?.repo_id],
    queryFn: () => listDrafts({ repoId: d!.repo_id }),
    enabled: !!d && d.status === "draft",
  });

  // `loaded` is the draft as the form was last loaded (version + content). Local
  // edits are compared against it; every change is sent with its version. When
  // polling brings a newer version, an untouched form follows it, while a form
  // with unsaved edits is kept and the conflict banner offers a reload.
  const [loaded, setLoaded] = useState<{ version: number; form: Form } | undefined>();
  const [form, setForm] = useState<Form | undefined>();
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [conflict, setConflict] = useState(false);

  const dirty = dirtyAgainst(form, loaded?.form);
  const saved = loaded?.form;

  useEffect(() => {
    if (!d) return;
    if (!loaded || (d.version !== loaded.version && !dirty)) {
      setLoaded({ version: d.version, form: formOf(d) });
      setForm(formOf(d));
      setConflict(false);
    } else if (d.version !== loaded.version) {
      setConflict(true);
    }
    // Only a new server version should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.version]);

  const applyServerDraft = (next: DraftDetail) => {
    queryClient.setQueryData(["draft", draftId], next);
    setLoaded({ version: next.version, form: formOf(next) });
    setForm(formOf(next));
    setConflict(false);
    void queryClient.invalidateQueries({ queryKey: ["drafts"] });
    void queryClient.invalidateQueries({ queryKey: ["runs"] });
    void queryClient.invalidateQueries({ queryKey: ["run-drafts"] });
  };

  const onError = (err: unknown) => {
    if (isStale(err)) setConflict(true);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!form || !saved || !loaded) throw new Error("Nothing loaded");
      let current: DraftDetail | undefined;
      let version = loaded.version;
      const contentChanged = form.title !== saved.title || form.body !== saved.body || !sameList(form.labels, saved.labels);
      if (contentChanged) {
        current = await updateDraft(draftId, {
          version,
          title: form.title !== saved.title ? form.title : undefined,
          body: form.body !== saved.body ? form.body : undefined,
          labels: !sameList(form.labels, saved.labels) ? form.labels : undefined,
        });
        version = current.version;
      }
      if (!sameList(form.dependsOn, saved.dependsOn)) {
        current = await updateDraftDeps(draftId, form.dependsOn, version);
      }
      return current;
    },
    onSuccess: (next) => next && applyServerDraft(next),
    onError,
  });

  const approve = useMutation({
    mutationFn: () => approveDraft(draftId, loaded!.version),
    onSuccess: applyServerDraft,
    onError,
  });
  const unapprove = useMutation({ mutationFn: () => unapproveDraft(draftId), onSuccess: applyServerDraft, onError });
  const post = useMutation({ mutationFn: () => postDraft(draftId), onSuccess: applyServerDraft, onError });
  const retry = useMutation({ mutationFn: () => retryDraft(draftId), onSuccess: applyServerDraft, onError });
  const reconcile = useMutation({ mutationFn: () => reconcileDraft(draftId), onSuccess: applyServerDraft, onError });
  const remove = useMutation({
    mutationFn: () => deleteDraft(draftId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["drafts"] });
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      navigate(d ? `/queue?repo=${d.repo_id}` : "/queue");
    },
    onError,
  });

  const reload = async () => {
    const fresh = await queryClient.fetchQuery({ queryKey: ["draft", draftId], queryFn: () => getDraft(draftId) });
    applyServerDraft(fresh);
    save.reset();
    approve.reset();
    post.reset();
    retry.reset();
    reconcile.reset();
  };

  const labelChoices = useMemo(() => {
    const names = new Set([...(labels.data ?? []).map((l) => l.name), ...(form?.labels ?? [])]);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [labels.data, form?.labels]);

  if (draft.isPending) return <p className="muted spaced">Loading…</p>;
  if (draft.error || !d) {
    return (
      <section className="card">
        <p className="status status--bad">{draft.error?.message ?? "Draft not found."}</p>
        <a href="/queue" onClick={linkHandler("/queue")}>
          Back to the board
        </a>
      </section>
    );
  }

  const editable = d.status === "draft" && !!form;
  const busy =
    save.isPending || approve.isPending || unapprove.isPending || post.isPending || retry.isPending || reconcile.isPending || remove.isPending;
  const actionError = [save.error, approve.error, unapprove.error, post.error, retry.error, reconcile.error, remove.error].find(
    (e): e is Error => e instanceof Error && !isStale(e),
  );
  const boardHref = `/queue?repo=${d.repo_id}`;
  const toggle = (list: string[], value: string) =>
    (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]).sort();

  return (
    <>
      <div className="editor-back">
        <a href={boardHref} onClick={linkHandler(boardHref)}>
          ← Board
        </a>
      </div>

      {conflict && (
        <div className="banner banner--warn" role="alert">
          <span>
            <strong>Edited by someone else.</strong> Reload to see the latest version; your unsaved changes will be discarded.
          </span>
          <button type="button" onClick={() => void reload()}>
            Reload
          </button>
        </div>
      )}

      <section className="card">
        <div className="editor-head">
          <span className={`pill pill--${d.status === "failed" ? "bad" : d.status === "posted" ? "good" : "active"}`}>
            {DRAFT_STATUS_LABEL[d.status]}
          </span>
          <span className="muted small">
            {d.repo.owner}/{d.repo.name}
            {d.template_name ? ` · ${d.template_name}` : ""} · by {d.created_by}
            {d.approved_by ? ` · approved by ${d.approved_by}` : ""}
          </span>
          {d.gitea_url && (
            <a className="small" href={d.gitea_url} target="_blank" rel="noopener noreferrer">
              Open #{d.gitea_number} in Gitea
            </a>
          )}
        </div>

        {d.status === "approved" && (
          <p className="status small">This draft is approved and read-only. Unapprove it to make changes.</p>
        )}
        {d.status === "posting" && (
          <p className="status small">
            Posting to Gitea… if this doesn't finish within a few minutes, Reconcile checks whether it went through.
          </p>
        )}
        {d.last_error && <p className="status status--bad small">{d.last_error}</p>}
        {actionError && <p className="status status--bad">{actionError.message}</p>}

        {editable ? (
          <label className="field">
            <span>Title</span>
            <input
              value={form.title}
              maxLength={DRAFT_TITLE_MAX}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </label>
        ) : (
          <h2 className="editor-title">{d.title}</h2>
        )}

        {editable ? (
          <div className="field">
            <div className="tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "write"} onClick={() => setTab("write")}>
                Write
              </button>
              <button type="button" role="tab" aria-selected={tab === "preview"} onClick={() => setTab("preview")}>
                Preview
              </button>
            </div>
            {tab === "write" ? (
              <textarea
                className="editor-body"
                rows={22}
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
              />
            ) : (
              <div className="preview">
                <Markdown>{form.body}</Markdown>
              </div>
            )}
          </div>
        ) : (
          <div className="preview">
            <Markdown>{d.body}</Markdown>
          </div>
        )}

        <div className="editor-grid">
          <div>
            <h3>Labels</h3>
            {editable ? (
              <>
                {labels.isPending && <p className="muted small">Loading labels…</p>}
                {labels.error && <p className="status status--bad small">{labels.error.message}</p>}
                <div className="chips">
                  {labelChoices.map((name) => (
                    <label key={name} className={form.labels.includes(name) ? "chip chip--on" : "chip"}>
                      <input
                        type="checkbox"
                        checked={form.labels.includes(name)}
                        onChange={() => setForm({ ...form, labels: toggle(form.labels, name) })}
                      />
                      {name}
                    </label>
                  ))}
                </div>
              </>
            ) : d.labels.length > 0 ? (
              <div className="chips">
                {d.labels.map((l) => (
                  <span key={l} className="badge">
                    {l}
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted small">None</p>
            )}
          </div>

          <div>
            <h3>Depends on</h3>
            {editable ? (
              <>
                {siblings.isPending && <p className="muted small">Loading drafts…</p>}
                {siblings.data && siblings.data.filter((s) => s.id !== d.id).length === 0 && (
                  <p className="muted small">No other drafts in this repository.</p>
                )}
                <ul className="dep-list">
                  {siblings.data
                    ?.filter((s) => s.id !== d.id)
                    .map((s) => (
                      <li key={s.id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={form.dependsOn.includes(s.id)}
                            onChange={() => setForm({ ...form, dependsOn: toggle(form.dependsOn, s.id) })}
                          />
                          <span>{s.title}</span>
                          <span className="muted small"> · {DRAFT_STATUS_LABEL[s.status]}</span>
                        </label>
                      </li>
                    ))}
                </ul>
              </>
            ) : d.depends_on.length > 0 ? (
              <ul className="dep-list">
                {d.depends_on.map((x) => (
                  <li key={x.id}>
                    <a href={`/drafts/${x.id}`} onClick={linkHandler(`/drafts/${x.id}`)}>
                      {x.title}
                    </a>
                    <span className="muted small"> · {DRAFT_STATUS_LABEL[x.status]}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">None</p>
            )}
            {d.dependents.length > 0 && (
              <p className="muted small">
                Needed by: {d.dependents.map((x) => x.title).join(", ")}
              </p>
            )}
          </div>
        </div>

        <div className="actions editor-actions">
          {editable && (
            <>
              <button type="button" onClick={() => save.mutate()} disabled={!dirty || busy || !form.title.trim()}>
                {save.isPending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => approve.mutate()}
                disabled={dirty || busy || conflict}
                title={dirty ? "Save your changes before approving" : undefined}
              >
                {approve.isPending ? "Approving…" : "Approve"}
              </button>
              {dirty && <span className="muted small">Save before approving.</span>}
              <span className="spacer" />
              {confirmDelete ? (
                <>
                  <span className="small">Delete this draft?</span>
                  <button type="button" className="danger" onClick={() => remove.mutate()} disabled={busy}>
                    {remove.isPending ? "Deleting…" : "Delete"}
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(false)} disabled={busy}>
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" className="link danger-link" onClick={() => setConfirmDelete(true)} disabled={busy}>
                  Delete
                </button>
              )}
            </>
          )}
          {d.status === "approved" && (
            <>
              <button type="button" className="primary" onClick={() => post.mutate()} disabled={busy}>
                {post.isPending ? "Posting…" : "Post to Gitea"}
              </button>
              <button type="button" onClick={() => unapprove.mutate()} disabled={busy}>
                {unapprove.isPending ? "Unapproving…" : "Unapprove"}
              </button>
            </>
          )}
          {d.status === "failed" && (
            <button type="button" onClick={() => retry.mutate()} disabled={busy}>
              {retry.isPending ? "Retrying…" : "Retry"}
            </button>
          )}
          {d.status === "posting" && (
            <button type="button" onClick={() => reconcile.mutate()} disabled={busy}>
              {reconcile.isPending ? "Reconciling…" : "Reconcile"}
            </button>
          )}
        </div>
      </section>

      <section className="card">
        <h2>History</h2>
        <ul className="history">
          {d.events.map((e) => (
            <li key={e.id}>
              <span>
                <strong>{e.actor ?? "system"}</strong> {describeEvent(e)}
              </span>
              <span className="muted small">{new Date(e.created_at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

/** Whether a form differs from the snapshot it was loaded from. */
function dirtyAgainst(form: Form | undefined, base: Form | undefined): boolean {
  if (!form || !base) return false;
  return (
    form.title !== base.title ||
    form.body !== base.body ||
    !sameList(form.labels, base.labels) ||
    !sameList(form.dependsOn, base.dependsOn)
  );
}
