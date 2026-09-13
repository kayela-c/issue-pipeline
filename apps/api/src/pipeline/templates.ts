import { parse as parseYaml } from "yaml";
import type { TreeEntry } from "../forge/types";

/**
 * Gitea issue templates, parsed the way Gitea 1.25 reads them
 * (services/issue/template.go and modules/issue/template/template.go).
 */

/** Directories Gitea searches, in its order of preference. */
export const TEMPLATE_DIRS = [
  "ISSUE_TEMPLATE",
  "issue_template",
  ".gitea/ISSUE_TEMPLATE",
  ".gitea/issue_template",
  ".github/ISSUE_TEMPLATE",
  ".github/issue_template",
  ".gitlab/ISSUE_TEMPLATE",
  ".gitlab/issue_template",
];

/** The "_No response_" placeholder Gitea writes for an empty form field. */
export const NO_RESPONSE = "_No response_";

export type FormFieldType = "markdown" | "textarea" | "input" | "dropdown" | "checkboxes";

export interface FormField {
  type: FormFieldType;
  id: string;
  label: string;
  description: string;
  required: boolean;
  /** Dropdown options, or checkbox labels. */
  options: string[];
  /** Dropdowns: whether several options may be chosen. */
  multiple: boolean;
  /** Markdown fields: their fixed text. */
  value: string;
}

export interface IssueTemplate {
  /** File name within the template directory, e.g. "feature-task.yml". */
  file: string;
  path: string;
  kind: "markdown" | "form";
  name: string;
  about: string;
  /** Title prefix or default title. */
  title: string;
  labels: string[];
  /** Markdown templates: the template body. Forms: a rendered skeleton. */
  body: string;
  /** Forms only: the fields, in order. */
  fields: FormField[];
}

/** Template files in the tree, preferring the first matching directory like Gitea. */
export function findTemplatePaths(entries: TreeEntry[]): string[] {
  for (const dir of TEMPLATE_DIRS) {
    const prefix = `${dir}/`;
    const files = entries
      .map((e) => e.path)
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
      .filter((p) => /\.(md|ya?ml)$/i.test(p))
      .filter((p) => !/\/config\.ya?ml$/i.test(p))
      .sort();
    if (files.length > 0) return files;
  }
  return [];
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

/** Gitea accepts labels as a list or a comma-separated string. */
function asLabelList(v: unknown): string[] {
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return items.map((s) => String(s).trim()).filter(Boolean);
}

function parseField(raw: unknown): FormField | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const type = asString(r.type) as FormFieldType;
  if (!["markdown", "textarea", "input", "dropdown", "checkboxes"].includes(type)) return undefined;

  const attributes = (r.attributes ?? {}) as Record<string, unknown>;
  const validations = (r.validations ?? {}) as Record<string, unknown> | null;
  const rawOptions = Array.isArray(attributes.options) ? attributes.options : [];
  const options = rawOptions
    .map((o) => (typeof o === "string" ? o : asString((o as Record<string, unknown> | null)?.label)))
    .filter(Boolean);

  return {
    type,
    id: asString(r.id),
    label: asString(attributes.label),
    description: asString(attributes.description),
    required: Boolean(validations && validations.required === true),
    options,
    multiple: attributes.multiple === true,
    value: asString(attributes.value),
  };
}

/** Whether a field produces a `### label` section in the issue body. */
export const rendersSection = (f: FormField) => f.type !== "markdown" && f.id !== "" && f.label !== "";

/** The body a form produces, with a placeholder per field. */
export function formSkeleton(fields: FormField[]): string {
  return fields
    .filter(rendersSection)
    .map((f) => `### ${f.label}\n\n${NO_RESPONSE}\n`)
    .join("\n");
}

function splitFrontMatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  try {
    const meta = parseYaml(match[1]!);
    return meta && typeof meta === "object"
      ? { meta: meta as Record<string, unknown>, body: match[2]! }
      : { meta: {}, body: content };
  } catch {
    // Gitea treats unparseable front matter as plain Markdown.
    return { meta: {}, body: content };
  }
}

/** Parse one template file. Returns undefined for a file Gitea would reject. */
export function parseTemplate(path: string, content: string): IssueTemplate | undefined {
  const file = path.slice(path.lastIndexOf("/") + 1);
  // Strip a UTF-8 byte-order mark.
  const text = content.replace(/^\uFEFF/, "");

  if (/\.md$/i.test(file)) {
    const { meta, body } = splitFrontMatter(text);
    return {
      file,
      path,
      kind: "markdown",
      name: asString(meta.name) || file,
      about: asString(meta.about) || asString(meta.description),
      title: asString(meta.title),
      labels: asLabelList(meta.labels),
      body,
      fields: [],
    };
  }

  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== "object") return undefined;
  const d = doc as Record<string, unknown>;
  if (!Array.isArray(d.body)) return undefined;

  const fields = d.body.map(parseField).filter((f): f is FormField => f !== undefined);
  return {
    file,
    path,
    kind: "form",
    name: asString(d.name) || file,
    about: asString(d.about) || asString(d.description),
    title: asString(d.title),
    labels: asLabelList(d.labels),
    body: formSkeleton(fields),
    fields,
  };
}

/** Text of a template for the prompt: what the body must look like. */
export function describeTemplate(t: IssueTemplate): string {
  const lines = [`Template file: ${t.file}`, `Name: ${t.name}`];
  if (t.about) lines.push(`About: ${t.about}`);
  if (t.title) lines.push(`Title prefix: ${JSON.stringify(t.title)}`);

  if (t.kind === "markdown") {
    lines.push("Kind: Markdown template. The body must keep this template's structure and headings:", "", t.body);
    return lines.join("\n");
  }

  lines.push(
    "Kind: issue form. The body must contain exactly these sections, in this order, each written as",
    `"### <label>" followed by a blank line and the answer. Write "${NO_RESPONSE}" for an optional field with nothing to say.`,
    "",
  );
  for (const f of t.fields.filter(rendersSection)) {
    const parts = [`- ### ${f.label}`, `[${f.type}${f.required ? ", required" : ", optional"}]`];
    if (f.description) parts.push(`- ${f.description}`);
    if (f.type === "dropdown") {
      parts.push(
        `- answer with ${f.multiple ? "one or more of these options, comma-separated" : "exactly one of these options"}, copied exactly: ${f.options.map((o) => JSON.stringify(o)).join(", ")}`,
      );
    }
    if (f.type === "checkboxes") {
      parts.push(`- answer as a checklist of these items, "- [x] " or "- [ ] ": ${f.options.map((o) => JSON.stringify(o)).join(", ")}`);
    }
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}
