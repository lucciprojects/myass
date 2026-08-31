import "dotenv/config";
import { drizzle } from "drizzle-orm/mysql2";

export * from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

export const db = drizzle(process.env.DATABASE_URL);
