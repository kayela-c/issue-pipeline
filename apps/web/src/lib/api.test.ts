import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getMe, request } from "./api";
import { z } from "zod";

const respond = (status: number, body?: unknown) =>
  vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request", () => {
  it("maps a 401 to an unauthorized ApiError", async () => {
    vi.stubGlobal("fetch", respond(401, { error: { code: "unauthorized", message: "Not signed in." } }));
    const err = await getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("maps a 403 from the org gate to forbidden", async () => {
    vi.stubGlobal("fetch", respond(403, { error: { code: "forbidden", message: "You must be a member." } }));
    await expect(getMe()).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });

  it("sends JSON bodies with a JSON content type and same-origin credentials", async () => {
    const fetch = respond(200, { ok: true });
    vi.stubGlobal("fetch", fetch);
    await request("POST", "/api/things", z.object({ ok: z.boolean() }), { a: 1 });

    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/things");
    expect(init.credentials).toBe("same-origin");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init.body).toBe('{"a":1}');
  });

  it("rejects a success body that fails the schema", async () => {
    vi.stubGlobal("fetch", respond(200, { id: "not-a-uuid" }));
    await expect(getMe()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("reports network failures as transport errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(getMe()).rejects.toMatchObject({ code: "transport", status: 0 });
  });
});
