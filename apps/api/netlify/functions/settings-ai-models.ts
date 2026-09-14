import type { Config } from "@netlify/functions";
import type { AiModelListResponse } from "@issue-pipeline/shared";
import { AI_PROVIDER_LABELS } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { getUserAiSettings } from "../../src/db/settings";
import { HttpError, json } from "../../src/http";
import { AiSettingsError, teamKey } from "../../src/llm";
import { ModelListError, listProviderModels } from "../../src/llm/models";
import { requireAiProvider, userApiKey } from "../../src/settings/ai";

/** GET: the provider's models, listed live with the caller's own key (or the team's). */
export default withAuth(async (_req, { user }, context) => {
  const provider = requireAiProvider(context.params.provider);
  const label = AI_PROVIDER_LABELS[provider];

  let apiKey: string | undefined;
  try {
    apiKey = userApiKey(user.id, await getUserAiSettings(user.id), provider) ?? teamKey(provider);
  } catch (err) {
    if (err instanceof AiSettingsError) throw new HttpError("bad_request", err.message);
    throw err;
  }
  if (!apiKey) {
    throw new HttpError("bad_request", `Save an API key for ${label} to list its models.`);
  }

  try {
    const body: AiModelListResponse = { models: await listProviderModels(provider, apiKey) };
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
