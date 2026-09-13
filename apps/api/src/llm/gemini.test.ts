import { describe, expect, it, vi } from "vitest";
import { GeminiApiError, createGeminiClient, describeGeminiError, isRetryableGeminiError } from "./gemini";
import { LlmOutputError } from "./types";

const drafts = {
  drafts: [{ key: "a", title: "T", body: "B", template_name: null, labels: [], depends_on: [] }],
  reviewer_notes: null,
};

const ok = (json: unknown, extra: { finishReason?: string; parts?: unknown[] } = {}) =>
  new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            role: "model",
            parts: extra.parts ?? [
              { text: "thinking about it", thought: true },
              { text: JSON.stringify(json), thoughtSignature: "sig-1" },
            ],
          },
          finishReason: extra.finishReason ?? "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 },
    }),
    { status: 200 },
  );

const error = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { code: status, message, status: "X" } }), { status });

function client(responses: Response[]) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => responses.shift()!);
  const llm = createGeminiClient({
    apiKey: "key",
    modelSelect: "gemini-3.5-flash-lite",
    modelDraft: "gemini-3.8-flash",
    maxOutputTokens: 32000,
    fetch: fetch as unknown as typeof globalThis.fetch,
    backoffMs: () => 0,
  });
  const bodies = () => fetch.mock.calls.map(([, init]) => JSON.parse(init.body as string));
  return { llm, fetch, bodies };
}

const draftInput = { repo: "o/r", rawIssue: "notes", routing: "", files: "", templates: "", labels: [] };

describe("createGeminiClient", () => {
  it("requests schema-constrained JSON and ignores thought parts", async () => {
    const { llm, fetch, bodies } = client([ok({ paths: ["a.ts"] })]);
    const result = await llm.selectFiles({ repo: "o/r", rawIssue: "x", readmeExcerpt: "", routing: "", fileList: "a.ts", shown: 1, total: 1 });

    expect(result).toEqual({ paths: ["a.ts"], usage: { inputTokens: 100, outputTokens: 50 } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("key");
    const body = bodies()[0];
    expect(body.generationConfig).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: { type: "object" } });
    expect(body.generationConfig.responseJsonSchema).not.toHaveProperty("$schema");
    expect(body.systemInstruction.parts[0].text).toMatch(/pick which repository files/);
  });

  it("replays the model turn verbatim, thought signature included, before the repair request", async () => {
    const { llm, bodies } = client([ok(drafts), ok(drafts)]);
    const conversation = await llm.draftIssues(draftInput);
    await conversation.repair(['Draft "a": label "x" does not exist.']);

    const repairContents = bodies()[1].contents;
    expect(repairContents).toHaveLength(3);
    expect(repairContents[1]).toMatchObject({ role: "model", parts: [{ thought: true }, { thoughtSignature: "sig-1" }] });
    expect(repairContents[2].parts[0].text).toContain('label "x" does not exist');
  });

  it("reports truncated, blocked, and non-JSON output as output errors", async () => {
    await expect(client([ok(drafts, { finishReason: "MAX_TOKENS" })]).llm.draftIssues(draftInput)).rejects.toThrow(/ran out of output space/);
    await expect(client([ok(drafts, { finishReason: "SAFETY" })]).llm.draftIssues(draftInput)).rejects.toThrow(/SAFETY/);
    await expect(client([ok(null, { parts: [{ text: "Sure! Here you go" }] })]).llm.draftIssues(draftInput)).rejects.toBeInstanceOf(LlmOutputError);
  });
});

describe("Gemini errors", () => {
  const failWith = async (res: Response) => client([res]).llm.draftIssues(draftInput).catch((e: unknown) => e);

  it("treats depleted credits as permanent with guidance (the error seen with this key)", async () => {
    const err = await failWith(
      error(429, "Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing."),
    );
    expect(err).toBeInstanceOf(GeminiApiError);
    expect(isRetryableGeminiError(err)).toBe(false);
    expect(describeGeminiError(err)).toMatch(/no credits or quota left/);
  });

  it("retries high demand and rate limits in the client, then succeeds (503 seen from gemini-3.8-flash)", async () => {
    const { llm, fetch } = client([
      error(503, "This model is currently experiencing high demand. Spikes in demand are usually temporary."),
      error(429, "Resource has been exhausted (e.g. check quota)."),
      ok(drafts),
    ]);
    await expect(llm.draftIssues(draftInput)).resolves.toMatchObject({ output: drafts });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("gives up after four attempts with a retryable error, and never retries depleted credits", async () => {
    const overloaded = () => error(503, "high demand");
    const busy = client([overloaded(), overloaded(), overloaded(), overloaded()]);
    const err = await busy.llm.draftIssues(draftInput).catch((e: unknown) => e);
    expect(isRetryableGeminiError(err)).toBe(true);
    expect(busy.fetch).toHaveBeenCalledTimes(4);

    const broke = client([error(429, "Your prepayment credits are depleted.")]);
    await broke.llm.draftIssues(draftInput).catch(() => undefined);
    expect(broke.fetch).toHaveBeenCalledTimes(1);
  });

  it("explains bad keys and unknown models", async () => {
    expect(describeGeminiError(await failWith(error(400, "API key not valid. Please pass a valid API key.")))).toMatch(/GOOGLE_API_KEY/);
    expect(describeGeminiError(await failWith(error(404, "models/nope is not found")))).toMatch(/model not found/);
  });
});
