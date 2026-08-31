import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "../../database/migrations",
  dialect: "mysql",
  dbCredentials: {
    host: "localhost",
    port: 3306,
    user: "myass",
    password: "myass",
    database: "myass",
  },
});