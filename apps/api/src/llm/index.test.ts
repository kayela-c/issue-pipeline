import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiSettingsError, describeLlmError, llmConfigFromEnv, recordedModels, resolveLlmConfig } from "./index";

const ENV_NAMES = [
  "LLM_PROVIDER",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL_SELECT",
  "ANTHROPIC_MODEL_DRAFT",
  "OPENAI_API_KEY",
  "OPENAI_MODEL_SELECT",
  "OPENAI_MODEL_DRAFT",
  "XAI_API_KEY",
  "VENICE_API_KEY",
];

beforeEach(() => {
  for (const name of ENV_NAMES) vi.stubEnv(name, "");
});
afterEach(() => vi.unstubAllEnvs());

describe("resolveLlmConfig", () => {
  it("uses the team default when the user has not picked a provider", () => {
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "team-anthropic");
    const config = resolveLlmConfig({ provider: null, modelSelect: "ignored", modelDraft: "ignored" });
    expect(config).toEqual({
      provider: "anthropic",
      apiKey: "team-anthropic",
      modelSelect: "claude-haiku-4-5-20251001",
      modelDraft: "claude-sonnet-5",
      keySource: "team",
    });
    expect(recordedModels(config)).toEqual({ select: "anthropic/claude-haiku-4-5-20251001", draft: "anthropic/claude-sonnet-5" });
  });

  it("prefers the user's own key and models", () => {
    vi.stubEnv("OPENAI_API_KEY", "team-openai");
    vi.stubEnv("OPENAI_MODEL_SELECT", "team-small");
    vi.stubEnv("OPENAI_MODEL_DRAFT", "team-big");
    expect(resolveLlmConfig({ provider: "openai", modelSelect: "mine-small", modelDraft: null, apiKey: "user-openai" })).toEqual({
      provider: "openai",
      apiKey: "user-openai",
      modelSelect: "mine-small",
      modelDraft: "team-big",
      keySource: "user",
    });
  });

  it("falls back to the team's key for the chosen provider", () => {
    vi.stubEnv("VENICE_API_KEY", "team-venice");
    expect(resolveLlmConfig({ provider: "venice", modelSelect: "a", modelDraft: "b" })).toMatchObject({
      apiKey: "team-venice",
      keySource: "team",
    });
  });

  it("asks for a key when neither the user nor the team has one", () => {
    expect(() => resolveLlmConfig({ provider: "grok", modelSelect: "a", modelDraft: "b" })).toThrow(AiSettingsError);
    expect(() => resolveLlmConfig({ provider: "grok", modelSelect: "a", modelDraft: "b" })).toThrow(/API key for Grok/);
  });

  it("asks for models when a provider has no default", () => {
    expect(() => resolveLlmConfig({ provider: "openai", modelSelect: null, modelDraft: "b", apiKey: "k" })).toThrow(
      /Choose the OpenAI models/,
    );
  });
});

describe("llmConfigFromEnv", () => {
  it("explains a team provider without a key or models as a settings problem shown on the run", () => {
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    const err = (() => {
      try {
        llmConfigFromEnv();
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AiSettingsError);
    expect(describeLlmError(err)).toMatch(/ANTHROPIC_API_KEY/);

    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "k");
    expect(() => llmConfigFromEnv()).toThrow(/OPENAI_MODEL_SELECT and OPENAI_MODEL_DRAFT/);
  });
});
