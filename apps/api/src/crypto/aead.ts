import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM with a caller-chosen additional authenticated data string. Shared
 * by the session cookies (AAD = cookie name) and stored credentials (AAD =
 * table, column, and owning user), so a value sealed for one place cannot be
 * replayed in another.
 */

const FORMAT_PREFIX = "v1.";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The current key, plus an optional previous key accepted during rotation. */
export interface Keyring {
  current: Buffer;
  previous?: Buffer;
}

export function parseKey(name: string, value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error(`${name} must be 32 bytes encoded as base64`);
  }
  return key;
}

/** A keyring from `<name>` and `<name>_PREVIOUS`. */
export function keyringFromEnvVars(name: string): Keyring {
  const current = parseKey(name, process.env[name]);
  if (!current) {
    throw new Error(`${name} is not set`);
  }
  return { current, previous: parseKey(`${name}_PREVIOUS`, process.env[`${name}_PREVIOUS`]) };
}

export function encrypt(plaintext: string, aad: string, keys: Keyring): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keys.current, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return FORMAT_PREFIX + Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64url");
}

/** The plaintext, or `undefined` for anything tampered, sealed under another AAD, stale-keyed, or malformed. */
export function decrypt(value: string | undefined | null, aad: string, keys: Keyring): string | undefined {
  if (!value?.startsWith(FORMAT_PREFIX)) return undefined;
  const raw = Buffer.from(value.slice(FORMAT_PREFIX.length), "base64url");
  if (raw.length <= IV_BYTES + TAG_BYTES) return undefined;

  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);

  for (const key of [keys.current, keys.previous]) {
    if (!key) continue;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      // Wrong key or tampered value: try the next key.
    }
  }
  return undefined;
}
