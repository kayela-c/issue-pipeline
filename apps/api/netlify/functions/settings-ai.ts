import type { Config } from "@netlify/functions";
import { selectAiProviderRequestSchema } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { getUserAiSettings, setUserAiProvider } from "../../src/db/settings";
import { json, readJson } from "../../src/http";
import { toAiSettingsDto } from "../../src/settings/ai";

/** GET: the caller's AI settings (keys shown only as "saved, ending in ..."). PUT {provider}: pick a provider, or null for the team default. */
export default withAuth(async (req, { user }) => {
  if (req.method === "PUT") {
    const { provider } = await readJson(req, selectAiProviderRequestSchema);
    await setUserAiProvider(user.id, provider);
  }
  return json(toAiSettingsDto(await getUserAiSettings(user.id)));
});

export const config: Config = { path: "/api/settings/ai", method: ["GET", "PUT"] };
