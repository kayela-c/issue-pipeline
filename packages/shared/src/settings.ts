import { z } from "zod";

/**
 * Per-user AI settings (docs/ARCHITECTURE.md Phase 6). A user either uses the
 * team default (the server's LLM_PROVIDER setup) or picks a provider; each
 * provider keeps its own models and, optionally, the user's own API key.
 * Keys are write-only: responses say whether one is saved and show its last
 * four characters, never the key.
 *
 * LM Studio is a model server on the user's own machine, so the server only
 * offers it when it runs locally too (`netlify dev`): `providers` in the
 * response leaves it out when deployed.
 */

export const AI_PROVIDERS = ["anthropic", "gemini", "grok", "openai", "venice", "lmstudio"] as const;
export const aiProviderSchema = z.enum(AI_PROVIDERS);
export type AiProvider = z.infer<typeof aiProviderSchema>;

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: "Anthropic",
  gemini: "Gemini",
  grok: "Grok (xAI)",
  openai: "OpenAI",
  venice: "Venice",
  lmstudio: "LM Studio",
};

/** Providers that run on a URL the user sets (a local model server) rather than a fixed API. */
export const LOCAL_AI_PROVIDERS: readonly AiProvider[] = ["lmstudio"];

const modelId = z.string().trim().min(1).max(200);

export const aiProviderSettingsSchema = z.object({
  provider: aiProviderSchema,
  /** The user's chosen models; null means the team's (or built-in) default. */
  model_select: z.string().nullable(),
  model_draft: z.string().nullable(),
  has_key: z.boolean(),
  key_last4: z.string().nullable(),
  /** Whether the server has its own key for this provider to fall back on. */
  team_key: z.boolean(),
  /** The models used when the user has not chosen any; null when there is no default. */
  default_model_select: z.string().nullable(),
  default_model_draft: z.string().nullable(),
  /** Local providers only (null otherwise): the server URL and model context length, and the defaults used when unset. */
  base_url: z.string().nullable(),
  context_tokens: z.number().int().nullable(),
  default_base_url: z.string().nullable(),
  default_context_tokens: z.number().int().nullable(),
});
export type AiProviderSettings = z.infer<typeof aiProviderSettingsSchema>;

export const aiSettingsResponseSchema = z.object({
  /** The provider the user picked, or null for the team default. */
  provider: aiProviderSchema.nullable(),
  /** What "team default" currently means, e.g. "anthropic". */
  team_provider: z.string(),
  providers: z.array(aiProviderSettingsSchema),
});
export type AiSettingsResponse = z.infer<typeof aiSettingsResponseSchema>;

export const selectAiProviderRequestSchema = z.object({
  provider: aiProviderSchema.nullable(),
});
export type SelectAiProviderRequest = z.infer<typeof selectAiProviderRequestSchema>;

export const updateAiProviderRequestSchema = z.object({
  model_select: modelId.nullable(),
  model_draft: modelId.nullable(),
  /** Replaces the saved key. Omit to keep it. */
  api_key: z.string().trim().min(8).max(1000).optional(),
  /** Removes the saved key (ignored when api_key is given). */
  clear_key: z.boolean().optional(),
  /** Local providers only. Omit to keep the saved value; null to use the default. */
  base_url: z
    .string()
    .trim()
    .max(500)
    // http(s), a host with an optional port and path, no credentials in the URL.
    .regex(/^https?:\/\/[^\s/@?#]+(\/[^\s?#]*)?$/i, "Enter an http:// or https:// URL, like http://localhost:1234")
    .nullable()
    .optional(),
  context_tokens: z.number().int().min(1024).max(10_000_000).nullable().optional(),
});
export type UpdateAiProviderRequest = z.infer<typeof updateAiProviderRequestSchema>;

export const aiModelSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
});
export type AiModel = z.infer<typeof aiModelSchema>;

export const aiModelListResponseSchema = z.object({ models: z.array(aiModelSchema) });
export type AiModelListResponse = z.infer<typeof aiModelListResponseSchema>;

export const aiTestResponseSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  model_select: z.string().nullable(),
  model_draft: z.string().nullable(),
});
export type AiTestResponse = z.infer<typeof aiTestResponseSchema>;
