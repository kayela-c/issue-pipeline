import Anthropic from "@anthropic-ai/sdk";
import { AI_PROVIDERS, AI_PROVIDER_LABELS, LOCAL_AI_PROVIDERS, type AiProvider } from "@issue-pipeline/shared";
import { createAnthropicClient, describeAnthropicError, isRetryableAnthropicError } from "./anthropic";
import { createGeminiClient, describeGeminiError, isRetryableGeminiError } from "./gemini";
import {
  createOpenAiCompatibleClient,
  describeOpenAiCompatibleError,
  isRetryableOpenAiCompatibleError,
} from "./openai";
import { LlmOutputError, type LlmClient } from "./types";

export * from "./types";

/**
 * Model provider selection.
 *
 * Each user may pick a provider, models, and their own API key in Settings
 * (src/settings/ai.ts). Without that, the team default comes from environment
 * variables, as before:
 *
 *   LLM_PROVIDER=anthropic  ANTHROPIC_API_KEY, ANTHROPIC_MODEL_SELECT, ANTHROPIC_MODEL_DRAFT
 *   LLM_PROVIDER=gemini     GOOGLE_API_KEY, GEMINI_MODEL_SELECT, GEMINI_MODEL_DRAFT
 *   LLM_PROVIDER=openai     OPENAI_API_KEY, OPENAI_MODEL_SELECT, OPENAI_MODEL_DRAFT
 *   LLM_PROVIDER=grok       XAI_API_KEY, XAI_MODEL_SELECT, XAI_MODEL_DRAFT
 *   LLM_PROVIDER=venice     VENICE_API_KEY, VENICE_MODEL_SELECT, VENICE_MODEL_DRAFT
 *   LLM_PROVIDER=lmstudio   LMSTUDIO_BASE_URL, LMSTUDIO_API_KEY, LMSTUDIO_MODEL_SELECT, LMSTUDIO_MODEL_DRAFT,
 *                           LMSTUDIO_CONTEXT_TOKENS
 *
 * LM Studio runs on the user's machine, so it is only usable while the server
 * runs locally too (`netlify dev`); see lmStudioAvailable(). Its URL, token,
 * and context length can be set in Settings like any other provider's key.
 *
 * A provider's env key and models also serve as the fallback for users who
 * pick that provider without adding their own. LLM_MAX_OUTPUT_TOKENS
 * optionally caps the drafting output for any provider.
 */
export const LLM_PROVIDERS = AI_PROVIDERS;
export type LlmProvider = AiProvider;

const ENV: Record<LlmProvider, { prefix: string; key?: string }> = {
  anthropic: { prefix: "ANTHROPIC", key: "ANTHROPIC_API_KEY" },
  gemini: { prefix: "GEMINI", key: "GOOGLE_API_KEY" },
  grok: { prefix: "XAI", key: "XAI_API_KEY" },
  openai: { prefix: "OPENAI", key: "OPENAI_API_KEY" },
  venice: { prefix: "VENICE", key: "VENICE_API_KEY" },
  // Only needed when LM Studio's "Require Authentication" is on.
  lmstudio: { prefix: "LMSTUDIO", key: "LMSTUDIO_API_KEY" },
};

/**
 * Built-in model ids. The OpenAI-compatible providers change their lineups
 * often, so they have none: the models are chosen in Settings or set by env.
 */
const DEFAULT_MODELS: Record<LlmProvider, { select: string; draft: string }> = {
  anthropic: { select: "claude-haiku-4-5-20251001", draft: "claude-sonnet-5" },
  gemini: { select: "gemini-3.5-flash-lite", draft: "gemini-3.8-flash" },
  grok: { select: "", draft: "" },
  openai: { select: "", draft: "" },
  venice: { select: "", draft: "" },
  // Whatever is loaded in LM Studio; there is no sensible default id.
  lmstudio: { select: "", draft: "" },
};

const label = (provider: LlmProvider) => AI_PROVIDER_LABELS[provider];

const isLocalProvider = (provider: LlmProvider) => LOCAL_AI_PROVIDERS.includes(provider);

/**
 * Whether local providers can be used: only when this server is not deployed.
 * Deployed functions cannot reach a model on someone's machine, and a
 * user-supplied URL fetched from production would be a request-forgery hole.
 * Netlify sets CONTEXT to "dev" under `netlify dev`; tests leave it unset.
 */
export const localProvidersAvailable = () => !process.env.CONTEXT || process.env.CONTEXT === "dev";

/** LM Studio's server URL and model context length from env, else LM Studio's defaults. */
export function teamLocalSettings(): { baseUrl: string; contextTokens: number } {
  return {
    baseUrl: process.env.LMSTUDIO_BASE_URL || "http://localhost:1234",
    contextTokens: positiveIntFromEnv("LMSTUDIO_CONTEXT_TOKENS") ?? 8_192,
  };
}

/**
 * A setup problem the user (or an admin) must fix; retrying will not help.
 * The message is shown on the run.
 */
export class AiSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiSettingsError";
  }
}

export function llmProviderFromEnv(): LlmProvider {
  const provider = process.env.LLM_PROVIDER || "anthropic";
  if (!(LLM_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`LLM_PROVIDER must be one of ${LLM_PROVIDERS.join(", ")}; got "${provider}"`);
  }
  return provider as LlmProvider;
}

/** The server's own key for a provider, if it has one. */
export function teamKey(provider: LlmProvider): string | undefined {
  const name = ENV[provider].key;
  return (name && process.env[name]) || undefined;
}

/** Models from `<PREFIX>_MODEL_SELECT/_DRAFT`, else the built-in defaults; null where there is neither. */
export function teamModels(provider: LlmProvider): { select: string | null; draft: string | null } {
  const { prefix } = ENV[provider];
  return {
    select: process.env[`${prefix}_MODEL_SELECT`] || DEFAULT_MODELS[provider].select || null,
    draft: process.env[`${prefix}_MODEL_DRAFT`] || DEFAULT_MODELS[provider].draft || null,
  };
}

/** Everything needed to build a client. */
export interface LlmConfig {
  provider: LlmProvider;
  /** Empty for LM Studio without authentication. */
  apiKey: string;
  modelSelect: string;
  modelDraft: string;
  /** Where the key came from, for messages. */
  keySource: "user" | "team";
  /** Local providers only. */
  baseUrl?: string;
  contextTokens?: number;
}

/** "provider/model" ids, as recorded on each run. */
export const recordedModels = (config: LlmConfig) => ({
  select: `${config.provider}/${config.modelSelect}`,
  draft: `${config.provider}/${config.modelDraft}`,
});

export interface UserAiChoice {
  /** The user's provider, or null for the team default. */
  provider: AiProvider | null;
  modelSelect: string | null;
  modelDraft: string | null;
  /** The user's own decrypted key for that provider. */
  apiKey?: string;
  /** Local providers only; null or undefined means the env/default value. */
  baseUrl?: string | null;
  contextTokens?: number | null;
}

/**
 * Resolve which provider, key, and models a user's run uses:
 * their provider with their own key, else with the team's key for it; with no
 * provider chosen, the team default from LLM_PROVIDER.
 */
export function resolveLlmConfig(choice: UserAiChoice): LlmConfig {
  if (!choice.provider) return llmConfigFromEnv();

  const provider = choice.provider;
  const local = isLocalProvider(provider);
  if (local && !localProvidersAvailable()) {
    throw new AiSettingsError(
      `${label(provider)} runs on your own machine, so it only works when the app runs locally. Choose another provider in Settings, then retry the run.`,
    );
  }
  // A local model server usually needs no key.
  const apiKey = choice.apiKey || teamKey(provider) || (local ? "" : undefined);
  if (apiKey === undefined) {
    throw new AiSettingsError(
      `Add an API key for ${label(provider)} in Settings, or switch back to the team default, then retry the run.`,
    );
  }
  const team = teamModels(provider);
  const modelSelect = choice.modelSelect || team.select;
  const modelDraft = choice.modelDraft || team.draft;
  if (!modelSelect || !modelDraft) {
    throw new AiSettingsError(`Choose the ${label(provider)} models to use in Settings, then retry the run.`);
  }
  const config: LlmConfig = { provider, apiKey, modelSelect, modelDraft, keySource: choice.apiKey ? "user" : "team" };
  if (local) {
    const team = teamLocalSettings();
    config.baseUrl = choice.baseUrl || team.baseUrl;
    config.contextTokens = choice.contextTokens || team.contextTokens;
  }
  return config;
}

/** The team default: LLM_PROVIDER with its env key and models. */
export function llmConfigFromEnv(): LlmConfig {
  const provider = llmProviderFromEnv();
  const { prefix, key } = ENV[provider];
  const models = teamModels(provider);
  if (!models.select || !models.draft) {
    throw new AiSettingsError(
      `The team AI provider (${label(provider)}) has no models configured: set ${prefix}_MODEL_SELECT and ${prefix}_MODEL_DRAFT, or choose a provider in Settings.`,
    );
  }
  const local = isLocalProvider(provider);
  const apiKey = teamKey(provider) ?? (local ? "" : undefined);
  if (apiKey === undefined) {
    throw new AiSettingsError(
      `The team AI provider (${label(provider)}) has no API key configured (${key}). Choose a provider and add your own key in Settings.`,
    );
  }
  return {
    provider,
    apiKey,
    modelSelect: models.select,
    modelDraft: models.draft,
    keySource: "team",
    ...(local ? teamLocalSettings() : {}),
  };
}

function positiveIntFromEnv(name: string): number | undefined {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function createLlmClient(config: LlmConfig): LlmClient {
  const maxOutput = positiveIntFromEnv("LLM_MAX_OUTPUT_TOKENS");
  const models = { modelSelect: config.modelSelect, modelDraft: config.modelDraft };

  switch (config.provider) {
    case "anthropic":
      return createAnthropicClient({
        client: new Anthropic({ apiKey: config.apiKey }),
        ...models,
        jsonMode: "structured",
        caching: true,
        maxOutputTokens: maxOutput ?? 64_000,
      });

    case "gemini":
      return createGeminiClient({ apiKey: config.apiKey, ...models, maxOutputTokens: maxOutput ?? 32_000 });

    case "grok":
    case "openai":
    case "venice":
      return createOpenAiCompatibleClient({
        provider: config.provider,
        apiKey: config.apiKey,
        ...models,
        maxOutputTokens: maxOutput ?? 32_000,
      });

    case "lmstudio": {
      if (!localProvidersAvailable()) {
        throw new AiSettingsError("LM Studio only works when the app runs locally. Choose another provider in Settings.");
      }
      const team = teamLocalSettings();
      return createAnthropicClient({
        // LM Studio ignores the key unless "Require Authentication" is enabled.
        client: new Anthropic({
          baseURL: lmStudioRoot(config.baseUrl || team.baseUrl),
          apiKey: config.apiKey || "lm-studio",
          timeout: 15 * 60 * 1000,
        }),
        ...models,
        jsonMode: "tool",
        caching: false,
        maxOutputTokens: maxOutput ?? positiveIntFromEnv("LMSTUDIO_MAX_OUTPUT_TOKENS") ?? 4_096,
        contextTokens: config.contextTokens ?? team.contextTokens,
      });
    }
  }
}

/** The server root: the SDK adds `/v1/...` itself, so a pasted `.../v1` is trimmed. */
export const lmStudioRoot = (baseUrl: string) => baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");

export const llmClientFromEnv = (): LlmClient => createLlmClient(llmConfigFromEnv());

/** Transient provider trouble (rate limits, overload, 5xx, network): safe to retry later. */
export const isRetryableLlmError = (err: unknown) =>
  isRetryableAnthropicError(err) || isRetryableGeminiError(err) || isRetryableOpenAiCompatibleError(err);

/** A run-error message for any provider's failure, or undefined for non-AI errors. */
export function describeLlmError(err: unknown): string | undefined {
  if (err instanceof LlmOutputError || err instanceof AiSettingsError) return err.message;
  return describeAnthropicError(err) ?? describeGeminiError(err) ?? describeOpenAiCompatibleError(err);
}
