import { decrypt, encrypt, keyringFromEnvVars, type Keyring } from "./aead";

/**
 * Credentials users add in Settings, stored in Postgres only as ciphertext
 * under CREDENTIALS_KEY (CREDENTIALS_KEY_PREVIOUS is accepted during rotation).
 *
 * The additional authenticated data names the column, the owning user, and the
 * credential's subject (e.g. the provider), so a ciphertext copied into another
 * row, user, or provider does not decrypt.
 */

export interface CredentialSlot {
  /** "<table>.<column>", e.g. "user_ai_providers.api_key". */
  column: string;
  userId: string;
  /** What the credential is for, e.g. "openai". */
  subject: string;
}

export const credentialKeysFromEnv = (): Keyring => keyringFromEnvVars("CREDENTIALS_KEY");

const aad = (slot: CredentialSlot) => `${slot.column}:${slot.userId}:${slot.subject}`;

export function sealCredential(value: string, slot: CredentialSlot, keys: Keyring = credentialKeysFromEnv()): string {
  return encrypt(value, aad(slot), keys);
}

/** The credential, or undefined when it cannot be decrypted for this slot. */
export function openCredential(
  sealed: string | null | undefined,
  slot: CredentialSlot,
  keys: Keyring = credentialKeysFromEnv(),
): string | undefined {
  return decrypt(sealed, aad(slot), keys);
}

/** The last four characters, for "saved key ending in ..." displays. */
export const lastFour = (value: string) => value.slice(-4);
