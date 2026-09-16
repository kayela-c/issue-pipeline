import type { Config } from "@netlify/functions";
import type { AiTestResponse } from "@issue-pipeline/shared";
import { redact, withAuth } from "../../src/auth/withAuth";
import { getUserAiSettings } from "../../src/db/settings";
import { json } from "../../src/http";
import { AiSettingsError, createLlmClient, describeLlmError, resolveLlmConfig } from "../../src/llm";
import { requireAiProvider, userApiKey } from "../../src/settings/ai";

/** A tiny structured request, answerable by any model. */
const PROBE = {
  repo: "example/settings-test",
  rawIssue: "Settings connection test. Pick README.md.",
  readmeExcerpt: "",
  routing: "",
  fileList: "README.md",
  shown: 1,
  total: 1,
};

/**
 * POST: check the caller's saved settings for one provider with one small
 * structured-output call per model (select, then draft). Always 200; `ok`
 * says whether it worked and `message` why not.
 */
export default withAuth(async (_req, { user }, context) => {
  const provider = requireAiProvider(context.params.provider);
  const settings = await getUserAiSettings(user.id);
  const row = settings.providers.find((p) => p.provider === provider);

  let modelSelect = row?.modelSelect ?? null;
  let modelDraft = row?.modelDraft ?? null;
  const result = (ok: boolean, message: string) => json({ ok, message, model_select: modelSelect, model_draft: modelDraft } satisfies AiTestResponse);

  let apiKey: string | undefined;
  try {
    const config = resolveLlmConfig({
      provider,
      modelSelect,
      modelDraft,
      apiKey: userApiKey(user.id, settings, provider),
      baseUrl: row?.baseUrl,
      contextTokens: row?.contextTokens,
    });
    apiKey = config.apiKey;
    modelSelect = config.modelSelect;
    modelDraft = config.modelDraft;

    await createLlmClient(config).selectFiles(PROBE);
    if (config.modelDraft !== config.modelSelect) {
      await createLlmClient({ ...config, modelSelect: config.modelDraft }).selectFiles(PROBE);
    }
    const whose = !config.apiKey ? "no key" : config.keySource === "user" ? "your key" : "the team key";
    return result(true, `Both models answered with structured output using ${whose}.`);
  } catch (err) {
    if (err instanceof AiSettingsError) return result(false, err.message);
    const message = describeLlmError(err);
    if (message) return result(false, redact(message, apiKey));
    // Not an AI error: log it with the key scrubbed rather than letting withAuth log it raw.
    console.error("ai settings test failed", { provider, message: redact(err instanceof Error ? err.message : String(err), apiKey) });
    return result(false, "The test failed unexpectedly. Try again.");
  }
});

export const config: Config = { path: "/api/settings/ai/:provider/test", method: "POST" };
