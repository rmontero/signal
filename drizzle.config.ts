import { defineConfig } from "drizzle-kit";

export default defineConfig({ dialect: "postgresql", schema: "./src/db/schema.ts", out: "./src/db/migrations", dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED ?? "" }, strict: true, verbose: true });
