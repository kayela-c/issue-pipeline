import type { Config, Context } from "@netlify/functions";
import { z } from "zod";
import { withAuth } from "../../src/auth/withAuth";
import { getSnapshot, saveSnapshot, updateDefaultBranch } from "../../src/db/repos";
import { claimRun, commitDrafts, failRun, setRunProgress } from "../../src/db/runs";
import { apiError, json } from "../../src/http";
import { hasValidJobSecret } from "../../src/jobs";
import { AiSettingsError, createLlmClient, recordedModels } from "../../src/llm";
import { llmConfigForUser } from "../../src/settings/ai";
import { TransientJobError, runDraftJob } from "../../src/pipeline/draft";

const bodySchema = z.object({ run_id: z.uuid() });

const store = { claimRun, setRunProgress, failRun, updateDefaultBranch, getSnapshot, saveSnapshot, commitDrafts };

const log = (message: string, detail: Record<string, unknown> = {}) => console.log(`[draft-run] ${message}`, detail);

/**
 * Stage 1 drafting job (background: Netlify answers 202 and runs up to 15 min).
 *
 * Deterministic failures are recorded on the run and return normally. A
 * transient failure is thrown out of this function so Netlify retries the
 * invocation (after 1 minute, then 2 more); runDraftJob stops throwing on the
 * last attempt.
 */
export default async (req: Request, context: Context) => {
  // Reject before touching the forwarded token: only this site's own
  // functions know the secret.
  if (!hasValidJobSecret(req)) {
    return apiError("forbidden", "Forbidden.");
  }

  const text = await req.text();
  const parsed = bodySchema.safeParse(JSON.parse(text || "null"));
  if (!parsed.success) {
    return apiError("bad_request", "Expected {run_id}.");
  }
  const runId = parsed.data.run_id;

  let retryable: unknown;
  const handler = withAuth(async (_req, { forge, user }) => {
    // The AI provider, key, and models of the user who triggered this run
    // (their Settings, else the team default).
    let llm, llmConfig;
    try {
      llmConfig = await llmConfigForUser(user.id);
      llm = createLlmClient(llmConfig);
    } catch (err) {
      if (!(err instanceof AiSettingsError)) throw err;
      await failRun(runId, err.message);
      log("ai settings unusable", { runId });
      return json({ outcome: "failed" });
    }

    try {
      const result = await runDraftJob(runId, {
        store,
        forge,
        llm,
        models: recordedModels(llmConfig),
        // netlify dev does not replay failed background functions.
        maxAttempts: process.env.NETLIFY_DEV === "true" ? 1 : undefined,
        log,
      });
      log("finished", { runId, ...result });
      return json(result);
    } catch (err) {
      // withAuth would turn this into a 500 response; keep it so it can be rethrown.
      if (err instanceof TransientJobError) {
        retryable = err;
        return apiError("upstream_error", err.message);
      }
      throw err;
    }
  });

  const res = await handler(new Request(req.url, { method: req.method, headers: req.headers, body: text }), context);

  if (retryable) throw retryable;
  if (res.status === 401 || res.status === 403) {
    // The forwarded token expired, was revoked, or its user left the org.
    await failRun(runId, "Your Gitea session could not be used for this run. Sign in again and retry.");
  } else if (res.status >= 500) {
    // Gitea or the database was unavailable while authenticating: let Netlify retry.
    throw new Error(`draft-run could not start (HTTP ${res.status})`);
  }
  return res;
};

export const config: Config = { path: "/internal/draft-run", method: "POST" };
