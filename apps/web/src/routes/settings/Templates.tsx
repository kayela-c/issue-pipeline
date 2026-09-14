import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FORGES,
  FORGE_LABELS,
  TEMPLATE_CONTENT_MAX,
  TEMPLATE_KINDS,
  TEMPLATE_KIND_LABELS,
  kindsForForges,
  type Forge,
  type IssueTemplateDto,
  type TemplateKind,
  type TemplatePreviewResponse,
} from "@issue-pipeline/shared";
import { useEffect, useState } from "react";
import { Markdown } from "../../components/Markdown";
import { ApiError, createTemplate, deleteTemplate, listTemplates, previewTemplate, updateTemplate } from "../../lib/api";

const EXAMPLES: Record<TemplateKind, string> = {
  markdown: `---
name: Bug report
about: Something is broken
labels: [bug]
---
## Summary

## Steps to reproduce
1.

## Expected result

## Actual result
`,
  form: `name: Feature task
description: A piece of work to build
labels: [feature]
body:
  - type: textarea
    id: summary
    attributes:
      label: Summary
      description: What should be built, in a sentence or two
    validations:
      required: true
  - type: dropdown
    id: area
    attributes:
      label: Area
      options:
        - Frontend
        - Backend
        - Infrastructure
    validations:
      required: true
  - type: textarea
    id: acceptance
    attributes:
      label: Acceptance criteria
  - type: checkboxes
    id: checks
    attributes:
      label: Before closing
      options:
        - label: Tests added
        - label: Docs updated
`,
};

/** Team-wide issue templates: list, create, edit, delete, with a preview parsed the way drafting reads them. */
export function Templates() {
  const templates = useQuery({ queryKey: ["templates"], queryFn: listTemplates });
  const [editing, setEditing] = useState<IssueTemplateDto | "new" | null>(null);

  return (
    <>
      <section className="card">
        <div className="row">
          <h2>Templates</h2>
          <button type="button" className="primary" onClick={() => setEditing("new")} disabled={editing === "new"}>
            New template
          </button>
        </div>
        <p className="muted small">
          Shared with the whole team. When submitting notes, a repository's own templates are used unless you pick one of
          these. A run keeps a copy of the template it used, so editing or deleting a template never changes existing runs.
        </p>
        {templates.isPending && <p className="muted">Loading…</p>}
        {templates.error && <p className="status status--bad">{templates.error.message}</p>}
        {templates.data?.length === 0 && <p className="muted">No templates yet.</p>}
        {templates.data && templates.data.length > 0 && (
          <ul className="list">
            {templates.data.map((t) => (
              <li key={t.id} className="row">
                <div>
                  <strong>{t.name}</strong>
                  <span className="badge">{t.kind === "form" ? "issue form" : "Markdown"}</span>
                  {t.forges.map((f) => (
                    <span key={f} className="badge">
                      {FORGE_LABELS[f]}
                    </span>
                  ))}
                  <div className="muted small">
                    {t.file} · updated {new Date(t.updated_at).toLocaleString()}
                    {t.updated_by && ` by ${t.updated_by}`}
                  </div>
                </div>
                <button type="button" onClick={() => setEditing(t)} disabled={editing !== "new" && editing?.id === t.id}>
                  Edit
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing && (
        <TemplateEditor
          key={editing === "new" ? "new" : `${editing.id}@${editing.version}`}
          template={editing === "new" ? undefined : editing}
          onDone={(saved) => setEditing(saved ?? null)}
        />
      )}
    </>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function TemplateEditor({
  template,
  onDone,
}: {
  template?: IssueTemplateDto;
  /** Called with the saved template (to keep editing it), or nothing to close. */
  onDone: (saved?: IssueTemplateDto) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(template?.name ?? "");
  const [forges, setForges] = useState<Forge[]>(template?.forges ?? ["gitea"]);
  const [kind, setKind] = useState<TemplateKind>(template?.kind ?? "form");
  const [content, setContent] = useState(template?.content ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const allowedKinds = kindsForForges(forges);

  const toggleForge = (forge: Forge) => {
    const next = forges.includes(forge) ? forges.filter((f) => f !== forge) : FORGES.filter((f) => f === forge || forges.includes(f));
    setForges(next);
    // A form cannot be offered on a Markdown-only forge.
    if (!kindsForForges(next).includes(kind)) setKind("markdown");
  };

  const previewInput = useDebounced({ kind, content, forges }, 400);
  const preview = useQuery({
    queryKey: ["template-preview", previewInput],
    queryFn: () => previewTemplate(previewInput),
    enabled: previewInput.content.trim() !== "",
    placeholderData: (previous) => previous,
    retry: false,
  });

  const afterSave = (saved: IssueTemplateDto) => {
    void queryClient.invalidateQueries({ queryKey: ["templates"] });
    onDone(saved);
  };

  const save = useMutation({
    mutationFn: () => {
      const input = { name, forges, kind, content };
      return template ? updateTemplate(template.id, { ...input, version: template.version }) : createTemplate(input);
    },
    onSuccess: afterSave,
  });

  const remove = useMutation({
    mutationFn: () => deleteTemplate(template!.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["templates"] });
      onDone();
    },
  });

  const stale = save.error instanceof ApiError && (save.error.details as { reason?: string } | undefined)?.reason === "stale";
  const reload = async () => {
    const fresh = await queryClient.fetchQuery({ queryKey: ["templates"], queryFn: listTemplates });
    onDone(fresh.find((t) => t.id === template?.id));
  };

  const dirty =
    !template ||
    name !== template.name ||
    kind !== template.kind ||
    content !== template.content ||
    forges.join() !== template.forges.join();
  const knownErrors = preview.data && previewInput.content === content && previewInput.kind === kind ? preview.data.errors : [];

  return (
    <section className="card">
      <h2>{template ? `Edit "${template.name}"` : "New template"}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label className="field">
          <span>Name</span>
          <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bug report" />
        </label>

        <fieldset className="field plain">
          <legend>Offered for</legend>
          <div className="chips">
            {FORGES.map((forge) => (
              <label key={forge} className={`chip${forges.includes(forge) ? " chip--on" : ""}`}>
                <input type="checkbox" checked={forges.includes(forge)} onChange={() => toggleForge(forge)} />
                {FORGE_LABELS[forge]}
              </label>
            ))}
          </div>
          <span className="muted small">
            Gitea and GitHub read Markdown templates and YAML issue forms; GitLab and Bitbucket take Markdown only.
          </span>
        </fieldset>

        <fieldset className="field plain">
          <legend>Format</legend>
          <div className="choice-list choice-list--inline">
            {TEMPLATE_KINDS.map((k) => (
              <label key={k} className="choice">
                <input
                  type="radio"
                  name="template-kind"
                  checked={kind === k}
                  disabled={!allowedKinds.includes(k)}
                  onChange={() => setKind(k)}
                />
                <span>
                  {TEMPLATE_KIND_LABELS[k]}
                  {!allowedKinds.includes(k) && <span className="muted small"> · not supported by every chosen forge</span>}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="editor-grid">
          <label className="field">
            <span className="row">
              <span>{kind === "form" ? "YAML" : "Markdown"}</span>
              <button type="button" className="link" onClick={() => setContent(EXAMPLES[kind])} disabled={content.trim() !== ""}>
                Start from an example
              </button>
            </span>
            <textarea
              className="editor-body"
              rows={24}
              maxLength={TEMPLATE_CONTENT_MAX}
              spellCheck={false}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={
                kind === "form"
                  ? "name, description, labels, and a body: list of fields (textarea, input, dropdown, checkboxes, markdown)"
                  : "Optional front matter (name, about, title, labels) between --- lines, then the issue body"
              }
            />
          </label>

          <div className="field">
            <span>Preview</span>
            <div className="preview">
              {!content.trim() && <p className="muted">Write or paste a template to see how drafting will read it.</p>}
              {content.trim() && preview.error && <p className="status status--bad">{preview.error.message}</p>}
              {content.trim() && preview.data && <PreviewBody preview={preview.data} kind={kind} />}
            </div>
          </div>
        </div>

        {save.error && (
          <p className="banner banner--warn">
            <span>{save.error.message}</span>
            {stale && (
              <button type="button" onClick={() => void reload()}>
                Reload
              </button>
            )}
          </p>
        )}
        {remove.error && <p className="status status--bad">{remove.error.message}</p>}

        <div className="editor-actions">
          <button
            type="submit"
            className="primary"
            disabled={!dirty || !name.trim() || !content.trim() || knownErrors.length > 0 || save.isPending}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={() => onDone()}>
            {dirty && template ? "Discard changes" : "Close"}
          </button>
          <span className="spacer" />
          {template &&
            (confirmDelete ? (
              <>
                <span className="muted small">Delete this template? Existing runs keep their copy.</span>
                <button type="button" className="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
                  {remove.isPending ? "Deleting…" : "Delete"}
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button type="button" className="link danger-link" onClick={() => setConfirmDelete(true)}>
                Delete template
              </button>
            ))}
        </div>
      </form>
    </section>
  );
}

function PreviewBody({ preview, kind }: { preview: TemplatePreviewResponse; kind: TemplateKind }) {
  const t = preview.template;
  return (
    <>
      {preview.errors.length > 0 && (
        <ul className="status status--bad">
          {preview.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {preview.warnings.length > 0 && (
        <ul className="muted small">
          {preview.warnings.map((w) => (
            <li key={w}>Note: {w}</li>
          ))}
        </ul>
      )}
      {t && (
        <>
          <dl className="meta">
            {t.title && (
              <>
                <dt>Title prefix</dt>
                <dd>{t.title}</dd>
              </>
            )}
            {t.about && (
              <>
                <dt>About</dt>
                <dd>{t.about}</dd>
              </>
            )}
            {t.labels.length > 0 && (
              <>
                <dt>Labels</dt>
                <dd>{t.labels.join(", ")}</dd>
              </>
            )}
          </dl>
          {kind === "markdown" ? (
            <Markdown>{t.body}</Markdown>
          ) : (
            <ol className="form-preview">
              {t.fields.map((f, i) => (
                <li key={`${i}-${f.label}`}>
                  <strong>### {f.label}</strong>
                  <span className="muted small">
                    {" "}
                    · {f.type}
                    {f.required ? ", required" : ", optional"}
                    {f.multiple ? ", multiple" : ""}
                  </span>
                  {f.description && <div className="muted small">{f.description}</div>}
                  {f.options.length > 0 && <div className="small">Options: {f.options.join(" · ")}</div>}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </>
  );
}
