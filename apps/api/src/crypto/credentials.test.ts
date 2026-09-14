import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { lastFour, openCredential, sealCredential, type CredentialSlot } from "./credentials";

const keys = { current: randomBytes(32) };
const slot: CredentialSlot = {
  column: "user_ai_providers.api_key",
  userId: "00000000-0000-4000-8000-000000000001",
  subject: "openai",
};
const secret = "sk-test-0123456789abcdef";

describe("credential sealing", () => {
  it("round-trips and never contains the plaintext", () => {
    const sealed = sealCredential(secret, slot, keys);
    expect(sealed).not.toContain(secret);
    expect(openCredential(sealed, slot, keys)).toBe(secret);
  });

  it("is bound to the user, subject, and column", () => {
    const sealed = sealCredential(secret, slot, keys);
    expect(openCredential(sealed, { ...slot, userId: "00000000-0000-4000-8000-000000000002" }, keys)).toBeUndefined();
    expect(openCredential(sealed, { ...slot, subject: "grok" }, keys)).toBeUndefined();
    expect(openCredential(sealed, { ...slot, column: "forge_connections.access_token" }, keys)).toBeUndefined();
  });

  it("accepts the previous key during rotation, and nothing else", () => {
    const old = { current: randomBytes(32) };
    const sealed = sealCredential(secret, slot, old);
    expect(openCredential(sealed, slot, { current: randomBytes(32), previous: old.current })).toBe(secret);
    expect(openCredential(sealed, slot, { current: randomBytes(32) })).toBeUndefined();
  });

  it("rejects tampered, empty, and foreign values", () => {
    const sealed = sealCredential(secret, slot, keys);
    const body = Buffer.from(sealed.slice(3), "base64url");
    body[14] = body[14]! ^ 0xff;
    expect(openCredential(`v1.${body.toString("base64url")}`, slot, keys)).toBeUndefined();
    expect(openCredential(null, slot, keys)).toBeUndefined();
    expect(openCredential("plaintext-key", slot, keys)).toBeUndefined();
  });

  it("shows only the last four characters", () => {
    expect(lastFour(secret)).toBe("cdef");
  });
});
