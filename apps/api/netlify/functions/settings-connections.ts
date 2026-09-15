import type { Config } from "@netlify/functions";
import type { ConnectionsResponse } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { listIdentities } from "../../src/db/identities";
import { json } from "../../src/http";
import { toConnectionDto } from "../../src/settings/connections";

/** GET: forges the caller has linked as an alternate sign-in. */
export default withAuth(async (_req, { user }) => {
  const rows = await listIdentities(user.id);
  const body: ConnectionsResponse = { connections: rows.map(toConnectionDto) };
  return json(body);
});

export const config: Config = { path: "/api/settings/connections", method: "GET" };
