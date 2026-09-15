import type { Config } from "@netlify/functions";
import { withAuth } from "../../src/auth/withAuth";
import { deleteIdentity } from "../../src/db/identities";
import { HttpError } from "../../src/http";
import { requireConnectableForge } from "../../src/settings/connections";

/** DELETE: unlink a forge. You can no longer sign in through it (Gitea sign-in is unaffected). */
export default withAuth(async (_req, { user }, context) => {
  const forge = requireConnectableForge(context.params.forge);
  if (!(await deleteIdentity(user.id, forge))) {
    throw new HttpError("not_found", "That forge is not linked.");
  }
  return new Response(null, { status: 204 });
});

export const config: Config = { path: "/api/settings/connections/:forge", method: "DELETE" };
