import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OAUTH_COOKIE,
  SESSION_COOKIE,
  oauthStateSchema,
  readCookie,
  seal,
  sessionCookieHeader,
  sessionSchema,
  unseal,
  withCookies,
  type Keyring,
  type Session,
} from "./session";

const keys: Keyring = { current: randomBytes(32) };

// Realistic sizes: Gitea access and refresh tokens are JWTs of a few hundred characters.
const session: Session = {
  uid: "00000000-0000-4000-8000-000000000001",
  gitea_id: 42,
  username: "a-fairly-long-gitea-username",
  access_token: `eyJ${"a".repeat(600)}`,
  refresh_token: `eyJ${"r".repeat(600)}`,
  access_expires_at: 1_800_000_000,
  session_started_at: 1_799_990_000,
};

describe("seal / unseal", () => {
  it("round-trips a session", () => {
    const sealed = seal(SESSION_COOKIE, session, keys);
    expect(sealed).not.toContain(session.access_token);
    expect(unseal(SESSION_COOKIE, sealed, keys, sessionSchema)).toEqual(session);
  });

  it("rejects a tampered value", () => {
    const sealed = seal(SESSION_COOKIE, session, keys);
    const body = Buffer.from(sealed.slice(3), "base64url");
    body[20] = body[20]! ^ 0xff;
    const tampered = `v1.${body.toString("base64url")}`;
    expect(unseal(SESSION_COOKIE, tampered, keys, sessionSchema)).toBeUndefined();
  });

  it("rejects a value sealed with another key", () => {
    const sealed = seal(SESSION_COOKIE, session, { current: randomBytes(32) });
    expect(unseal(SESSION_COOKIE, sealed, keys, sessionSchema)).toBeUndefined();
  });

  it("accepts the previous key during rotation", () => {
    const sealed = seal(SESSION_COOKIE, session, keys);
    const rotated: Keyring = { current: randomBytes(32), previous: keys.current };
    expect(unseal(SESSION_COOKIE, sealed, rotated, sessionSchema)).toEqual(session);
  });

  it("will not let one cookie's value be replayed as the other", () => {
    const sealed = seal(OAUTH_COOKIE, session, keys);
    expect(unseal(SESSION_COOKIE, sealed, keys, sessionSchema)).toBeUndefined();
  });

  it("rejects junk and payloads that fail the schema", () => {
    for (const junk of [undefined, "", "v1.", "v2.abc", "not-a-cookie"]) {
      expect(unseal(SESSION_COOKIE, junk, keys, sessionSchema)).toBeUndefined();
    }
    const wrongShape = seal(SESSION_COOKIE, { hello: "world" }, keys);
    expect(unseal(SESSION_COOKIE, wrongShape, keys, oauthStateSchema)).toBeUndefined();
  });
});

describe("cookies", () => {
  it("keeps the session cookie under the 4 KB browser limit", () => {
    const header = sessionCookieHeader(session, keys, 7 * 86_400, session.session_started_at);
    expect(header.length).toBeLessThan(4096);
  });

  it("sets __Host- compatible, HttpOnly attributes with the remaining lifetime", () => {
    const header = sessionCookieHeader(session, keys, 1000, session.session_started_at + 400);
    expect(header).toMatch(/^__Host-ip_session=v1\.[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
  });

  it("reads a named cookie", () => {
    const req = new Request("http://localhost/", { headers: { cookie: "a=1; __Host-ip_session=v1.xyz; b=2" } });
    expect(readCookie(req, SESSION_COOKIE)).toBe("v1.xyz");
    expect(readCookie(req, OAUTH_COOKIE)).toBeUndefined();
  });

  it("appends Set-Cookie headers without dropping existing ones", () => {
    const res = withCookies(new Response("ok", { headers: { "x-a": "1" } }), ["a=1", "b=2"]);
    expect(res.headers.get("x-a")).toBe("1");
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });
});
