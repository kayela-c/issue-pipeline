import type { Config } from "@netlify/functions";
import type { MeResponse } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { json } from "../../src/http";

/** The signed-in user. Doubles as the client's "am I allowed in?" check. */
export default withAuth(async (_req, { user }) => {
  const body: MeResponse = {
    id: user.id,
    gitea_id: user.giteaId,
    username: user.username,
    display_name: user.displayName,
  };
  return json(body);
});

export const config: Config = { path: "/api/me", method: "GET" };
