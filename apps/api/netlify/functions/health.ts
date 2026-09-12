import type { Config } from "@netlify/functions";
import { sql } from "drizzle-orm";
import { getDb } from "../../src/db/client";
import { json } from "../../src/http";
import type { HealthResponse } from "@issue-pipeline/shared";

const VERSION = process.env.COMMIT_REF?.slice(0, 7) ?? "dev";

/** Liveness + database reachability. No auth: this is the deploy smoke check. */
export default async () => {
  let db: HealthResponse["db"] = "ok";
  try {
    await getDb().execute(sql`select 1`);
  } catch (err) {
    db = "error";
    console.error("health: db ping failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const body: HealthResponse = {
    db,
    now: new Date().toISOString(),
    version: VERSION,
  };
  return json(body, db === "ok" ? 200 : 503);
};

export const config: Config = { path: "/api/health" };
