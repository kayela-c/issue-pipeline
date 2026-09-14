import { describe, expect, it, vi } from "vitest";
import { ModelListError, listProviderModels } from "./models";

const respond = (status: number, body: unknown) => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }));
  return { fetch, impl: fetch as unknown as typeof globalThis.fetch };
};

describe("listProviderModels", () => {
  it("lists OpenAI chat models only, sorted, with a bearer key", async () => {
    const { fetch, impl } = respond(200, {
      data: [{ id: "gpt-b" }, { id: "text-embedding-3-large" }, { id: "gpt-a" }, { id: "whisper-1" }],
    });
    await expect(listProviderModels("openai", "sk-1", impl)).resolves.toEqual([
      { id: "gpt-a", name: null },
      { id: "gpt-b", name: null },
    ]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/models");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-1");
  });

  it("drops Venice models known not to accept a response schema", async () => {
    const { fetch, impl } = respond(200, {
      data: [
        { id: "yes", model_spec: { name: "Yes", capabilities: { supportsResponseSchema: true } } },
        { id: "no", model_spec: { capabilities: { supportsResponseSchema: false } } },
        { id: "unknown" },
      ],
    });
    await expect(listProviderModels("venice", "v-1", impl)).resolves.toEqual([
      { id: "unknown", name: null },
      { id: "yes", name: "Yes" },
    ]);
    expect(fetch.mock.calls[0]![0]).toBe("https://api.venice.ai/api/v1/models?type=text");
  });

  it("maps Anthropic and Gemini lists", async () => {
    const anthropic = respond(200, { data: [{ id: "claude-x", display_name: "Claude X" }] });
    await expect(listProviderModels("anthropic", "a-1", anthropic.impl)).resolves.toEqual([{ id: "claude-x", name: "Claude X" }]);
    expect((anthropic.fetch.mock.calls[0]![1].headers as Record<string, string>)["x-api-key"]).toBe("a-1");

    const gemini = respond(200, {
      models: [
        { name: "models/gemini-a", displayName: "A", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embed", supportedGenerationMethods: ["embedContent"] },
      ],
    });
    await expect(listProviderModels("gemini", "g-1", gemini.impl)).resolves.toEqual([{ id: "gemini-a", name: "A" }]);
  });

  it("surfaces the provider's status and message", async () => {
    const { impl } = respond(401, { error: { message: "Incorrect API key provided" } });
    const err = await listProviderModels("grok", "bad", impl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelListError);
    expect(err).toMatchObject({ status: 401, message: "Incorrect API key provided" });
  });
});
