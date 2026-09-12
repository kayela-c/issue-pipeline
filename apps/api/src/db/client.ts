import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * One Drizzle client over the Neon HTTP driver.
 *
 * HTTP (not WebSocket) because functions are short-lived and stateless: each
 * statement is its own request, so there is no pool to keep warm. The tradeoff
 * is that interactive transactions are unavailable -- multi-statement atomic
 * writes go through db.batch([...]) instead.
 */

let cached: ReturnType<typeof create> | undefined;

function create() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  return drizzle(neon(url), { schema, casing: "snake_case" });
}

export function getDb() {
  cached ??= create();
  return cached;
}

export type Db = ReturnType<typeof getDb>;
export { schema };
