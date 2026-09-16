import type { Config } from "@netlify/functions";
import { LOCAL_AI_PROVIDERS, updateAiProviderRequestSchema } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { credentialKeysFromEnv, lastFour, sealCredential } from "../../src/crypto/credentials";
import { getUserAiSettings, upsertUserAiProvider } from "../../src/db/settings";
import { HttpError, json, readJson } from "../../src/http";
import { aiKeySlot, requireAiProvider, toAiSettingsDto } from "../../src/settings/ai";

/**
 * PUT {model_select, model_draft, api_key?, clear_key?, base_url?, context_tokens?}:
 * one provider's models and the caller's own key for it (plus, for LM Studio,
 * its server URL and context length). The key is sealed before it is stored and
 * is never sent back.
 */
export default withAuth(async (req, { user }, context) => {
  const provider = requireAiProvider(context.params.provider);
  const body = await readJson(req, updateAiProviderRequestSchema);

  let keys;
  if (body.api_key) {
    try {
      keys = credentialKeysFromEnv();
    } catch {
      throw new HttpError("internal_error", "The server cannot store API keys yet (CREDENTIALS_KEY is not set). Ask an admin.");
    }
  }
  const apiKey = body.api_key
    ? { sealed: sealCredential(body.api_key, aiKeySlot(user.id, provider), keys), last4: lastFour(body.api_key) }
    : body.clear_key
      ? null
      : undefined;

  await upsertUserAiProvider(user.id, provider, {
    modelSelect: body.model_select,
    modelDraft: body.model_draft,
    apiKey,
    // Ignored for hosted providers, whose URLs are fixed.
    ...(LOCAL_AI_PROVIDERS.includes(provider) ? { baseUrl: body.base_url, contextTokens: body.context_tokens } : {}),
  });
  return json(toAiSettingsDto(await getUserAiSettings(user.id)));
});

export const config: Config = { path: "/api/settings/ai/:provider", method: "PUT" };
