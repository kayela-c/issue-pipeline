import type { Config } from "@netlify/functions";
import type { AiModelListResponse } from "@issue-pipeline/shared";
import { AI_PROVIDER_LABELS, LOCAL_AI_PROVIDERS } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { getUserAiSettings } from "../../src/db/settings";
import { HttpError, json } from "../../src/http";
import { AiSettingsError, teamKey, teamLocalSettings } from "../../src/llm";
import { ModelListError, listProviderModels } from "../../src/llm/models";
import { requireAiProvider, userApiKey } from "../../src/settings/ai";

/** GET: the provider's models, listed live with the caller's own key (or the team's); for LM Studio, from its server URL. */
export default withAuth(async (_req, { user }, context) => {
  const provider = requireAiProvider(context.params.provider);
  const label = AI_PROVIDER_LABELS[provider];

  const local = LOCAL_AI_PROVIDERS.includes(provider);
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  try {
    const settings = await getUserAiSettings(user.id);
    apiKey = userApiKey(user.id, settings, provider) ?? teamKey(provider);
    // requireAiProvider has already refused local providers on a deployed server.
    if (local) baseUrl = settings.providers.find((p) => p.provider === provider)?.baseUrl || teamLocalSettings().baseUrl;
  } catch (err) {
    if (err instanceof AiSettingsError) throw new HttpError("bad_request", err.message);
    throw err;
  }
  if (!apiKey && !local) {
    throw new HttpError("bad_request", `Save an API key for ${label} to list its models.`);
  }

  try {
    const body: AiModelListResponse = { models: await listProviderModels(provider, apiKey ?? "", { baseUrl }) };
    return json(body);
  } catch (err) {
    if (!(err instanceof ModelListError)) throw err;
    if (err.status === 401 || err.status === 403) {
      throw new HttpError("bad_request", `${label} rejected the API key: ${err.message}`);
    }
    throw new HttpError("upstream_error", `Could not list ${label} models: ${err.message}`);
  }
});

export const config: Config = { path: "/api/settings/ai/:provider/models", method: "GET" };
