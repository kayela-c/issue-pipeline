import type { Config } from "@netlify/functions";
import type { MeResponse } from "@issue-pipeline/shared";
import { withAccount } from "../../src/auth/withAccount";
import { json } from "../../src/http";

/**
 * The signed-in user. Doubles as the client's "am I allowed in?" check. Does
 * not require a Gitea link (decision 22): `gitea_id: null` means the app
 * shows a "connect Gitea" screen instead of the normal one. Every other
 * endpoint stays behind withAuth, which does require Gitea and re-checks
 * GITEA_ALLOWED_ORG on every request.
 */
export default withAccount(async (_req, { user }) => {
  const body: MeResponse = {
    id: user.id,
    gitea_id: user.giteaId,
    username: user.username,
    display_name: user.displayName,
  };
  return json(body);
});

export const config: Config = { path: "/api/me", method: "GET" };
