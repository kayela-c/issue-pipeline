import {
  AI_PROVIDERS,
  AI_PROVIDER_LABELS,
  LOCAL_AI_PROVIDERS,
  aiProviderSchema,
  type AiProvider,
  type AiSettingsResponse,
} from "@issue-pipeline/shared";
import { openCredential, type CredentialSlot } from "../crypto/credentials";
import { HttpError } from "../http";
import { getUserAiSettings, type UserAiSettings } from "../db/settings";
import {
  AiSettingsError,
  llmProviderFromEnv,
  localProvidersAvailable,
  resolveLlmConfig,
  teamKey,
  teamLocalSettings,
  teamModels,
  type LlmConfig,
} from "../llm";

/** Providers this server can offer: local ones (LM Studio) only when it runs locally. */
export const availableAiProviders = (): AiProvider[] =>
  localProvidersAvailable() ? [...AI_PROVIDERS] : AI_PROVIDERS.filter((p) => !LOCAL_AI_PROVIDERS.includes(p));

/** A `:provider` route parameter this server offers, or a 404. */
export function requireAiProvider(value: string | undefined): AiProvider {
  const parsed = aiProviderSchema.safeParse(value);
  if (!parsed.success || !availableAiProviders().includes(parsed.data)) {
    throw new HttpError("not_found", "Unknown AI provider.");
  }
  return parsed.data;
}

/** Where a user's own key for `provider` is sealed. */
export const aiKeySlot = (userId: string, provider: AiProvider): CredentialSlot => ({
  column: "user_ai_providers.api_key",
  userId,
  subject: provider,
});

/** The settings as the browser sees them: whether a key is saved, never the key. */
export function toAiSettingsDto(settings: UserAiSettings): AiSettingsResponse {
  return {
    provider: settings.provider,
    team_provider: safeTeamProvider(),
    providers: availableAiProviders().map((provider) => {
      const row = settings.providers.find((p) => p.provider === provider);
      const team = teamModels(provider);
      const local = LOCAL_AI_PROVIDERS.includes(provider) ? teamLocalSettings() : null;
      return {
        provider,
        model_select: row?.modelSelect ?? null,
        model_draft: row?.modelDraft ?? null,
        has_key: Boolean(row?.apiKeyEnc),
        key_last4: row?.apiKeyEnc ? (row.apiKeyLast4 ?? null) : null,
        team_key: teamKey(provider) !== undefined,
        default_model_select: team.select,
        default_model_draft: team.draft,
        base_url: local ? (row?.baseUrl ?? null) : null,
        context_tokens: local ? (row?.contextTokens ?? null) : null,
        default_base_url: local?.baseUrl ?? null,
        default_context_tokens: local?.contextTokens ?? null,
      };
    }),
  };
}

/** The user's own key for a provider, decrypted; undefined when none is saved. */
export function userApiKey(userId: string, settings: UserAiSettings, provider: AiProvider): string | undefined {
  const sealed = settings.providers.find((p) => p.provider === provider)?.apiKeyEnc;
  if (!sealed) return undefined;
  const key = openCredential(sealed, aiKeySlot(userId, provider));
  if (key === undefined) {
    throw new AiSettingsError(
      `Your saved ${AI_PROVIDER_LABELS[provider]} API key can no longer be read. Add it again in Settings, then retry the run.`,
    );
  }
  return key;
}

/** Provider, key, and models for a run triggered by this user (docs/ARCHITECTURE.md Phase 6). */
export async function llmConfigForUser(userId: string): Promise<LlmConfig> {
  const settings = await getUserAiSettings(userId);
  const provider = settings.provider;
  if (!provider) return resolveLlmConfig({ provider: null, modelSelect: null, modelDraft: null });

  const row = settings.providers.find((p) => p.provider === provider);
  return resolveLlmConfig({
    provider,
    modelSelect: row?.modelSelect ?? null,
    modelDraft: row?.modelDraft ?? null,
    apiKey: userApiKey(userId, settings, provider),
    baseUrl: row?.baseUrl,
    contextTokens: row?.contextTokens,
  });
}

/** LLM_PROVIDER, or "unset" when it is invalid, so the settings page still loads. */
function safeTeamProvider(): string {
  try {
    return llmProviderFromEnv();
  } catch {
    return "unset";
  }
}
