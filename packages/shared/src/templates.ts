import { z } from "zod";

/**
 * Issue templates managed in Settings (docs/ARCHITECTURE.md Phase 7). Team-wide:
 * anyone in the org can create, edit, or delete them. A repository's own
 * templates stay the default when submitting notes; an app template is picked
 * explicitly and snapshotted onto the run.
 */

export const FORGES = ["gitea", "github", "gitlab", "bitbucket"] as const;
export const forgeSchema = z.enum(FORGES);
export type Forge = z.infer<typeof forgeSchema>;

export const FORGE_LABELS: Record<Forge, string> = {
  gitea: "Gitea",
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
};

export const TEMPLATE_KINDS = ["markdown", "form"] as const;
export const templateKindSchema = z.enum(TEMPLATE_KINDS);
export type TemplateKind = z.infer<typeof templateKindSchema>;

export const TEMPLATE_KIND_LABELS: Record<TemplateKind, string> = {
  markdown: "Markdown template",
  form: "Issue form (YAML)",
};

/**
 * The formats each forge's issue tracker understands. Gitea and GitHub read
 * Markdown templates and YAML issue forms; GitLab's description templates and
 * Bitbucket are Markdown only.
 */
export const FORGE_TEMPLATE_KINDS: Record<Forge, readonly TemplateKind[]> = {
  gitea: ["markdown", "form"],
  github: ["markdown", "form"],
  gitlab: ["markdown"],
  bitbucket: ["markdown"],
};

/** Formats every one of `forges` supports. */
export function kindsForForges(forges: readonly Forge[]): TemplateKind[] {
  return TEMPLATE_KINDS.filter((kind) => forges.every((f) => FORGE_TEMPLATE_KINDS[f].includes(kind)));
}

export const TEMPLATE_NAME_MAX = 100;
export const TEMPLATE_CONTENT_MAX = 50_000;

const timestamp = z.iso.datetime({ offset: true });

const templateFields = {
  name: z.string().trim().min(1, "Name the template").max(TEMPLATE_NAME_MAX),
  forges: z
    .array(forgeSchema)
    .min(1, "Choose at least one forge")
    .transform((forges) => FORGES.filter((f) => forges.includes(f))),
  kind: templateKindSchema,
  content: z.string().min(1, "The template is empty").max(TEMPLATE_CONTENT_MAX),
};

const supportsKind = (t: { forges: Forge[]; kind: TemplateKind }) => kindsForForges(t.forges).includes(t.kind);
const unsupportedKind = {
  message: "That format is not supported by every chosen forge (GitLab and Bitbucket take Markdown only).",
  path: ["kind"],
};

export const createTemplateRequestSchema = z.object(templateFields).refine(supportsKind, unsupportedKind);
export type CreateTemplateRequest = z.input<typeof createTemplateRequestSchema>;

export const updateTemplateRequestSchema = z
  .object({ ...templateFields, version: z.number().int().positive() })
  .refine(supportsKind, unsupportedKind);
export type UpdateTemplateRequest = z.input<typeof updateTemplateRequestSchema>;

export const issueTemplateSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  forges: z.array(forgeSchema),
  kind: templateKindSchema,
  content: z.string(),
  /** File name used as the drafts' template_name, e.g. "feature-task.yml". */
  file: z.string(),
  version: z.number().int(),
  created_by: z.string().nullable(),
  updated_by: z.string().nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type IssueTemplateDto = z.infer<typeof issueTemplateSchema>;

export const templateListResponseSchema = z.object({ templates: z.array(issueTemplateSchema) });
export type TemplateListResponse = z.infer<typeof templateListResponseSchema>;

export const templatePreviewRequestSchema = z.object({
  kind: templateKindSchema,
  content: z.string().max(TEMPLATE_CONTENT_MAX),
  forges: z.array(forgeSchema).default([]),
});
export type TemplatePreviewRequest = z.input<typeof templatePreviewRequestSchema>;

export const templateFieldPreviewSchema = z.object({
  type: z.string(),
  label: z.string(),
  description: z.string(),
  required: z.boolean(),
  options: z.array(z.string()),
  multiple: z.boolean(),
});

export const templatePreviewResponseSchema = z.object({
  /** Problems that block saving. */
  errors: z.array(z.string()),
  /** Things that work but may not do what the author expects. */
  warnings: z.array(z.string()),
  template: z
    .object({
      name: z.string(),
      about: z.string(),
      title: z.string(),
      labels: z.array(z.string()),
      /** Markdown: the template body. Forms: the skeleton a submitted form produces. */
      body: z.string(),
      /** Forms: the fields that become "### label" sections. */
      fields: z.array(templateFieldPreviewSchema),
    })
    .nullable(),
});
export type TemplatePreviewResponse = z.infer<typeof templatePreviewResponseSchema>;
