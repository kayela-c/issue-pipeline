import type { AiProvider } from "@issue-pipeline/shared";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "./client";
import type { UserAiProviderRow } from "./schema";

export interface UserAiSettings {
  provider: AiProvider | null;
  providers: UserAiProviderRow[];
}

export async function getUserAiSettings(userId: string): Promise<UserAiSettings> {
  const db = getDb();
  const [settings, providers] = await db.batch([
    db.select().from(schema.userAiSettings).where(eq(schema.userAiSettings.userId, userId)),
    db.select().from(schema.userAiProviders).where(eq(schema.userAiProviders.userId, userId)),
  ]);
  return { provider: (settings[0]?.provider as AiProvider | null | undefined) ?? null, providers };
}

/** Pick a provider, or null for the team default. */
export async function setUserAiProvider(userId: string, provider: AiProvider | null): Promise<void> {
  await getDb()
    .insert(schema.userAiSettings)
    .values({ userId, provider })
    .onConflictDoUpdate({ target: schema.userAiSettings.userId, set: { provider, updatedAt: sql`now()` } });
}

export interface ProviderUpdate {
  modelSelect: string | null;
  modelDraft: string | null;
  /** A sealed key to store, null to remove the saved key, undefined to keep it. */
  apiKey?: { sealed: string; last4: string } | null;
  /** Local providers only; undefined keeps the saved value, null clears it. */
  baseUrl?: string | null;
  contextTokens?: number | null;
}

export async function upsertUserAiProvider(userId: string, provider: AiProvider, update: ProviderUpdate): Promise<void> {
  const key =
    update.apiKey === undefined
      ? {}
      : { apiKeyEnc: update.apiKey?.sealed ?? null, apiKeyLast4: update.apiKey?.last4 ?? null };
  const values = {
    modelSelect: update.modelSelect,
    modelDraft: update.modelDraft,
    ...key,
    ...(update.baseUrl === undefined ? {} : { baseUrl: update.baseUrl }),
    ...(update.contextTokens === undefined ? {} : { contextTokens: update.contextTokens }),
  };
  await getDb()
    .insert(schema.userAiProviders)
    .values({ userId, provider, ...values })
    .onConflictDoUpdate({
      target: [schema.userAiProviders.userId, schema.userAiProviders.provider],
      set: { ...values, updatedAt: sql`now()` },
    });
}
