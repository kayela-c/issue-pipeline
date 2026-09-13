import { z } from "zod";
import { findCycle } from "./graph";
import { NO_RESPONSE, rendersSection, type IssueTemplate } from "./templates";

export const MAX_DRAFTS = 8;
export const MAX_TITLE_LENGTH = 255;
export const MAX_BODY_LENGTH = 60_000;

/**
 * The shape requested from the model. Deliberately loose: limits and
 * cross-references are checked by validateDrafts, whose messages are fed back
 * in the single repair call.
 */
export const draftOutputSchema = z.object({
  drafts: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      body: z.string(),
      template_name: z.string().nullable(),
      labels: z.array(z.string()),
      depends_on: z.array(z.string()),
    }),
  ),
  reviewer_notes: z.string().nullable(),
});
export type DraftOutput = z.infer<typeof draftOutputSchema>;
export type DraftItem = DraftOutput["drafts"][number];

export interface ValidationContext {
  labels: string[];
  templates: IssueTemplate[];
}

/** Every problem with the model output, as sentences the model can act on. */
export function validateDrafts(output: DraftOutput, ctx: ValidationContext): string[] {
  const errors: string[] = [];
  const { drafts } = output;

  if (drafts.length < 1 || drafts.length > MAX_DRAFTS) {
    errors.push(`Return between 1 and ${MAX_DRAFTS} drafts; got ${drafts.length}.`);
  }

  const keys = new Set<string>();
  for (const d of drafts) {
    if (!d.key.trim()) errors.push("Every draft needs a non-empty key.");
    else if (keys.has(d.key)) errors.push(`Draft key "${d.key}" is used more than once.`);
    keys.add(d.key);
  }

  const labelSet = new Set(ctx.labels);
  const templatesByFile = new Map(ctx.templates.map((t) => [t.file, t]));

  for (const d of drafts) {
    const where = `Draft "${d.key}"`;
    const title = d.title.trim();
    if (!title) errors.push(`${where}: title is empty.`);
    if (title.length > MAX_TITLE_LENGTH) errors.push(`${where}: title is ${title.length} characters; the limit is ${MAX_TITLE_LENGTH}.`);
    if (!d.body.trim()) errors.push(`${where}: body is empty.`);
    if (d.body.length > MAX_BODY_LENGTH) errors.push(`${where}: body is too long (${d.body.length} characters).`);

    for (const label of d.labels) {
      if (!labelSet.has(label)) {
        errors.push(`${where}: label "${label}" does not exist in this repository. Use only labels from the provided list.`);
      }
    }

    for (const dep of d.depends_on) {
      if (dep === d.key) errors.push(`${where}: a draft cannot depend on itself.`);
      else if (!keys.has(dep)) errors.push(`${where}: depends_on references unknown key "${dep}".`);
    }

    if (ctx.templates.length > 0) {
      if (d.template_name === null) {
        errors.push(`${where}: template_name is null, but the repository has issue templates; choose one.`);
      } else {
        const template = templatesByFile.get(d.template_name);
        if (!template) {
          errors.push(`${where}: template_name "${d.template_name}" is not one of the provided template files.`);
        } else if (template.kind === "form") {
          errors.push(...validateFormBody(where, d.body, template));
        }
      }
    } else if (d.template_name !== null) {
      errors.push(`${where}: template_name must be null because the repository has no issue templates.`);
    }
  }

  const edges = drafts.flatMap((d) =>
    d.depends_on.filter((dep) => dep !== d.key && keys.has(dep)).map((dep) => [d.key, dep] as const),
  );
  const cycle = findCycle(keys, edges);
  if (cycle) errors.push(`Dependencies form a cycle: ${cycle.join(" -> ")}. depends_on must be acyclic.`);

  return errors;
}

/** Split an issue-form body into its `### label` sections, in order. */
export function formSections(body: string): Array<{ label: string; content: string }> {
  const sections: Array<{ label: string; content: string }> = [];
  let current: { label: string; lines: string[] } | undefined;
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      if (current) sections.push({ label: current.label, content: current.lines.join("\n").trim() });
      current = { label: heading[1]!, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push({ label: current.label, content: current.lines.join("\n").trim() });
  return sections;
}

function validateFormBody(where: string, body: string, template: IssueTemplate): string[] {
  const errors: string[] = [];
  const expected = template.fields.filter(rendersSection);
  const sections = formSections(body);
  const byLabel = new Map(sections.map((s) => [s.label, s.content]));

  const order = sections.map((s) => s.label).filter((label) => expected.some((f) => f.label === label));
  const expectedOrder = expected.map((f) => f.label).filter((label) => byLabel.has(label));
  if (order.join("\n") !== expectedOrder.join("\n")) {
    errors.push(`${where}: sections are out of order; follow the template's field order.`);
  }

  for (const field of expected) {
    const content = byLabel.get(field.label);
    if (content === undefined) {
      errors.push(`${where}: missing the "### ${field.label}" section required by ${template.file}.`);
      continue;
    }
    const empty = content === "" || content === NO_RESPONSE;
    if (field.required && empty) {
      errors.push(`${where}: "${field.label}" is required and cannot be empty or "${NO_RESPONSE}".`);
    }
    if (field.type === "dropdown" && !empty) {
      const chosen = field.multiple ? content.split(",").map((s) => s.trim()) : [content];
      const invalid = chosen.filter((c) => !field.options.includes(c));
      if (invalid.length > 0 || (!field.multiple && chosen.length !== 1)) {
        errors.push(
          `${where}: "${field.label}" must be ${field.multiple ? "a comma-separated choice" : "exactly one"} of ${field.options.map((o) => JSON.stringify(o)).join(", ")}; got ${JSON.stringify(content)}.`,
        );
      }
    }
  }
  return errors;
}

/** Letters and digits only, lower-cased: "🐛 Bug" and "BUG" both become "bug". */
const lettersOnly = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Snap near-miss dropdown answers to the exact option text before validating.
 * Models often drop an option's emoji or change its case ("BUG" for
 * "🐛 Bug"). An answer is rewritten only when it matches exactly one option
 * after ignoring everything but letters and digits; anything else is left for
 * validation to reject.
 */
export function normalizeDropdownAnswers(output: DraftOutput, templates: IssueTemplate[]): DraftOutput {
  const byFile = new Map(templates.map((t) => [t.file, t]));

  const snap = (answer: string, options: string[]): string | undefined => {
    if (options.includes(answer)) return answer;
    const key = lettersOnly(answer);
    const matches = options.filter((o) => key !== "" && lettersOnly(o) === key);
    return matches.length === 1 ? matches[0] : undefined;
  };

  return {
    ...output,
    drafts: output.drafts.map((d) => {
      const template = d.template_name ? byFile.get(d.template_name) : undefined;
      if (template?.kind !== "form") return d;

      let body = d.body.replace(/\r\n/g, "\n");
      for (const field of template.fields.filter((f) => f.type === "dropdown" && rendersSection(f))) {
        // The section runs from its heading to the next "### " heading or the end.
        const section = new RegExp(`^(###\\s+${escapeRegExp(field.label)}[ \\t]*)\\n([\\s\\S]*?)(?=^###\\s|(?![\\s\\S]))`, "m");
        body = body.replace(section, (whole, heading: string, content: string) => {
          const answer = content.trim();
          if (answer === "" || answer === NO_RESPONSE) return whole;
          const parts = field.multiple ? answer.split(",").map((s) => s.trim()) : [answer];
          const snapped = parts.map((p) => snap(p, field.options));
          if (snapped.some((s) => s === undefined)) return whole;
          return `${heading}\n\n${snapped.join(", ")}\n\n`;
        });
      }
      return { ...d, body };
    }),
  };
}

const MARKER_COMMENT = /<!--[\s\S]*?issue-pipeline:[\s\S]*?-->/gi;

/**
 * Final clean-up of a validated draft: strip anything that could forge the
 * posting marker, trim, and add the template's own labels when they exist in
 * the repository (Gitea's UI does the same when an issue is filed from it).
 */
export function sanitizeDraft(d: DraftItem, ctx: ValidationContext): DraftItem {
  let body = d.body.replace(MARKER_COMMENT, "");
  // A marker split across an unterminated comment is still neutralised.
  body = body.replace(/issue-pipeline:/gi, "issue-pipeline-");

  const template = ctx.templates.find((t) => t.file === d.template_name);
  const labelSet = new Set(ctx.labels);
  const labels = [...new Set([...d.labels, ...(template?.labels ?? []).filter((l) => labelSet.has(l))])];

  return {
    ...d,
    title: d.title.trim(),
    body: body.trim(),
    labels,
    depends_on: [...new Set(d.depends_on)],
  };
}
