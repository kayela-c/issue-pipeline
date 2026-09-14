import { describe, expect, it, vi } from "vitest";
import {
  OpenAiCompatibleError,
  createOpenAiCompatibleClient,
  describeOpenAiCompatibleError,
  isRetryableOpenAiCompatibleError,
  type OpenAiCompatibleProvider,
} from "./openai";
import { LlmOutputError } from "./types";

const drafts = {
  drafts: [{ key: "a", title: "T", body: "B", template_name: null, labels: [], depends_on: [] }],
  reviewer_notes: null,
};

const ok = (content: string | null, extra: { finish_reason?: string; refusal?: string } = {}) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content, refusal: extra.refusal ?? null }, finish_reason: extra.finish_reason ?? "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 40 },
    }),
    { status: 200 },
  );

const error = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function client(responses: Response[], provider: OpenAiCompatibleProvider = "openai") {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => responses.shift()!);
  const llm = createOpenAiCompatibleClient({
    provider,
    apiKey: "sk-user-key",
    modelSelect: "small-model",
    modelDraft: "big-model",
    maxOutputTokens: 32000,
    fetch: fetch as unknown as typeof globalThis.fetch,
    backoffMs: () => 0,
  });
  const bodies = () => fetch.mock.calls.map(([, init]) => JSON.parse(init.body as string));
  return { llm, fetch, bodies };
}

const selectInput = { repo: "o/r", rawIssue: "x", readmeExcerpt: "", routing: "", fileList: "a.ts", shown: 1, total: 1 };
const draftInput = { repo: "o/r", rawIssue: "notes", routing: "", files: "", templates: "", labels: [] };

describe("createOpenAiCompatibleClient", () => {
  it("posts a json_schema request with a bearer key to the provider's fixed URL", async () => {
    const { llm, fetch, bodies } = client([ok(JSON.stringify({ paths: ["a.ts"] }))]);
    const result = await llm.selectFiles(selectInput);

    expect(result).toEqual({ paths: ["a.ts"], usage: { inputTokens: 100, outputTokens: 40 } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-user-key");
    const body = bodies()[0];
    expect(body.model).toBe("small-model");
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "select_files", strict: false } });
    expect(body.response_format.json_schema.schema).not.toHaveProperty("$schema");
    expect(body.max_completion_tokens).toBe(8000);
    expect(body.messages[0]).toMatchObject({ role: "system" });
  });

  it("uses each provider's URL and token-cap field; only Venice gets venice_parameters", async () => {
    const grok = client([ok(JSON.stringify({ paths: [] }))], "grok");
    await grok.llm.selectFiles(selectInput);
    expect(grok.fetch.mock.calls[0]![0]).toBe("https://api.x.ai/v1/chat/completions");
    expect(grok.bodies()[0]).toMatchObject({ max_tokens: 8000 });
    expect(grok.bodies()[0]).not.toHaveProperty("venice_parameters");

    const venice = client([ok(JSON.stringify({ paths: [] }))], "venice");
    await venice.llm.selectFiles(selectInput);
    expect(venice.fetch.mock.calls[0]![0]).toBe("https://api.venice.ai/api/v1/chat/completions");
    expect(venice.bodies()[0]).toMatchObject({
      max_completion_tokens: 8000,
      venice_parameters: { include_venice_system_prompt: false },
    });
  });

  it("replays the assistant turn before the repair request", async () => {
    const { llm, bodies } = client([ok(JSON.stringify(drafts)), ok(JSON.stringify(drafts))]);
    const conversation = await llm.draftIssues(draftInput);
    await conversation.repair(['Draft "a": label "x" does not exist.']);

    const messages = bodies()[1].messages;
    expect(messages).toHaveLength(4);
    expect(messages[2]).toEqual({ role: "assistant", content: JSON.stringify(drafts) });
    expect(messages[3].content).toContain('label "x" does not exist');
    expect(bodies()[1].model).toBe("big-model");
  });

  it("accepts JSON wrapped in a Markdown fence", async () => {
    const { llm } = client([ok("```json\n" + JSON.stringify(drafts) + "\n```")]);
    await expect(llm.draftIssues(draftInput)).resolves.toMatchObject({ output: drafts });
  });

  it("reports truncated, refused, empty, and non-JSON output as output errors", async () => {
    const text = JSON.stringify(drafts);
    await expect(client([ok(text, { finish_reason: "length" })]).llm.draftIssues(draftInput)).rejects.toThrow(/ran out of output space/);
    await expect(client([ok(null, { refusal: "no" })]).llm.draftIssues(draftInput)).rejects.toThrow(/declined/);
    await expect(client([ok(null)]).llm.draftIssues(draftInput)).rejects.toThrow(/returned nothing/);
    await expect(client([ok("Sure! Here you go")]).llm.draftIssues(draftInput)).rejects.toBeInstanceOf(LlmOutputError);
  });
});

describe("OpenAI-compatible errors", () => {
  const failWith = async (res: Response, provider: OpenAiCompatibleProvider = "openai") =>
    client([res], provider).llm.draftIssues(draftInput).catch((e: unknown) => e);

  it("retries rate limits and 5xx, then succeeds", async () => {
    const { llm, fetch } = client([
      error(500, { error: { message: "server error" } }),
      error(429, { error: { message: "Rate limit reached", code: "rate_limit_exceeded" } }),
      ok(JSON.stringify(drafts)),
    ]);
    await expect(llm.draftIssues(draftInput)).resolves.toMatchObject({ output: drafts });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("never retries exhausted quota, and explains it", async () => {
    const { llm, fetch } = client([
      error(429, { error: { message: "You exceeded your current quota.", code: "insufficient_quota" } }),
    ]);
    const err = await llm.draftIssues(draftInput).catch((e: unknown) => e);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(isRetryableOpenAiCompatibleError(err)).toBe(false);
    expect(describeOpenAiCompatibleError(err)).toMatch(/no credits or quota left/);
  });

  it("gives up after four retryable failures", async () => {
    const busy = () => error(503, { error: "overloaded" });
    const { llm, fetch } = client([busy(), busy(), busy(), busy()]);
    const err = await llm.draftIssues(draftInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiCompatibleError);
    expect(isRetryableOpenAiCompatibleError(err)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("explains bad keys, unknown models, and models without structured output, naming the provider", async () => {
    expect(describeOpenAiCompatibleError(await failWith(error(401, { error: "Incorrect API key" }), "grok"))).toMatch(
      /xAI API key was rejected.*Settings/,
    );
    expect(describeOpenAiCompatibleError(await failWith(error(404, { error: { message: "model not found" } })))).toMatch(
      /OpenAI model not found/,
    );
    expect(
      describeOpenAiCompatibleError(await failWith(error(400, { message: "response_format json_schema is not supported" }), "venice")),
    ).toMatch(/does not accept structured output/);
  });

  it("ignores errors from other providers", () => {
    expect(describeOpenAiCompatibleError(new Error("x"))).toBeUndefined();
  });
});
