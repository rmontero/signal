import { Pool } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import { schema } from "./schema";

export type SignalDb = NeonDatabase<typeof schema>;

export function createDb(connectionString = process.env.DATABASE_URL): { db: SignalDb; pool: Pool } {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString });
  return { db: drizzle(pool, { schema }), pool };
}
