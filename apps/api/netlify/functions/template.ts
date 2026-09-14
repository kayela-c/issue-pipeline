import type { Config } from "@netlify/functions";
import { updateTemplateRequestSchema, type IssueTemplateDto } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { deleteTemplate, getTemplate, toTemplateDtos, updateTemplate } from "../../src/db/templates";
import { HttpError, json, requireUuid } from "../../src/http";
import { assertUsableTemplate, readTemplateRequest, rethrowNameTaken } from "../../src/settings/templates";

/**
 * GET: one template. PATCH {name, forges, kind, content, version}: replace it,
 * 409 when someone else saved first. DELETE: remove it (runs keep their copy).
 * Anyone in the org may edit or delete team templates.
 */
export default withAuth(async (req, { user }, context) => {
  const id = requireUuid(context.params.id, "Template");

  if (req.method === "DELETE") {
    if (!(await deleteTemplate(id))) throw new HttpError("not_found", "Template not found.");
    return new Response(null, { status: 204 });
  }

  if (req.method === "PATCH") {
    const { version, ...input } = await readTemplateRequest(req, updateTemplateRequestSchema);
    assertUsableTemplate(input);
    const row = await updateTemplate(id, version, input, user.id).catch(rethrowNameTaken);
    if (!row) {
      const current = await getTemplate(id);
      if (!current) throw new HttpError("not_found", "Template not found.");
      throw new HttpError("conflict", "Edited by someone else. Reload to see the latest version.", {
        reason: "stale",
        version: current.version,
      });
    }
    const [body] = (await toTemplateDtos([row])) as [IssueTemplateDto];
    return json(body);
  }

  const row = await getTemplate(id);
  if (!row) throw new HttpError("not_found", "Template not found.");
  const [body] = (await toTemplateDtos([row])) as [IssueTemplateDto];
  return json(body);
});

export const config: Config = { path: "/api/templates/:id", method: ["GET", "PATCH", "DELETE"] };
