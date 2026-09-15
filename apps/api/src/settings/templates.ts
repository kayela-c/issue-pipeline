import type { Forge } from "@issue-pipeline/shared";
import { z } from "zod";
import type { Repo } from "../db/schema";
import { TemplateNameTaken, type TemplateInput } from "../db/templates";
import { HttpError, readJson } from "../http";
import { checkTemplate } from "../pipeline/templates";

/** The forge a tracked repo lives on (`repos.forge`, Phase 9). */
export const repoForge = (repo: Pick<Repo, "forge">): Forge => repo.forge as Forge;

/** Parse a template request, answering 400 with the first readable problem (e.g. an unsupported format). */
export async function readTemplateRequest<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readJson(req, z.unknown()));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HttpError("bad_request", first?.message ?? "Request body is invalid.", parsed.error.issues);
  }
  return parsed.data;
}

/** Refuse content the drafting pipeline could not use. */
export function assertUsableTemplate(input: TemplateInput): void {
  const { errors } = checkTemplate(input.kind, input.content, { name: input.name, forges: input.forges });
  if (errors.length > 0) {
    throw new HttpError("bad_request", `The template has problems: ${errors.join(" ")}`, { errors });
  }
}

/** A name clash as a 409 the editor can show. */
export function rethrowNameTaken(err: unknown): never {
  if (err instanceof TemplateNameTaken) throw new HttpError("conflict", err.message, { reason: "name_taken" });
  throw err;
}
