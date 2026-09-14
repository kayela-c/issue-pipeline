import type { Config } from "@netlify/functions";
import { createTemplateRequestSchema, type IssueTemplateDto, type TemplateListResponse } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { createTemplate, listTemplates, toTemplateDtos } from "../../src/db/templates";
import { json } from "../../src/http";
import { assertUsableTemplate, readTemplateRequest, rethrowNameTaken } from "../../src/settings/templates";

/** GET: the team's issue templates. POST {name, forges, kind, content}: create one. */
export default withAuth(async (req, { user }) => {
  if (req.method === "GET") {
    const body: TemplateListResponse = { templates: await toTemplateDtos(await listTemplates()) };
    return json(body);
  }

  const input = await readTemplateRequest(req, createTemplateRequestSchema);
  assertUsableTemplate(input);
  const row = await createTemplate(input, user.id).catch(rethrowNameTaken);
  const [body] = (await toTemplateDtos([row])) as [IssueTemplateDto];
  return json(body, 201);
});

export const config: Config = { path: "/api/templates", method: ["GET", "POST"] };
