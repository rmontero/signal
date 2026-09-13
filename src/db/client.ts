import { Pool } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import { schema } from "./schema";

export type SignalDb = NeonDatabase<typeof schema>;

export function createDb(connectionString = process.env.DATABASE_URL): { db: SignalDb; pool: Pool } {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000, statement_timeout: 5_000, query_timeout: 8_000, idle_in_transaction_session_timeout: 15_000 });
  return { db: drizzle(pool, { schema }), pool };
}
