import type { Config } from "@netlify/functions";
import { templatePreviewRequestSchema, type TemplatePreviewResponse } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { json, readJson } from "../../src/http";
import { checkTemplate, rendersSection } from "../../src/pipeline/templates";

/**
 * POST {kind, content, forges}: parse template content the way drafting will,
 * for the editor's live preview. Saves nothing. (Its own path rather than
 * /api/templates/preview, which would collide with /api/templates/:id.)
 */
export default withAuth(async (req) => {
  const { kind, content, forges } = await readJson(req, templatePreviewRequestSchema);
  const { template, errors, warnings } = checkTemplate(kind, content, { forges });

  const body: TemplatePreviewResponse = {
    errors,
    warnings,
    template: template
      ? {
          name: template.name,
          about: template.about,
          title: template.title,
          labels: template.labels,
          body: template.body,
          fields: template.fields.filter(rendersSection).map((f) => ({
            type: f.type,
            label: f.label,
            description: f.description,
            required: f.required,
            options: f.options,
            multiple: f.multiple,
          })),
        }
      : null,
  };
  return json(body);
});

export const config: Config = { path: "/api/template-preview", method: "POST" };
