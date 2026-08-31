import {
  boolean,
  float,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: varchar("id", { length: 36 }).primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const devices = mysqlTable("devices", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  status: mysqlEnum("status", ["online", "offline"]).default("offline").notNull(),
  firmwareVersion: varchar("firmware_version", { length: 64 }).default("simulator").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export const presets = mysqlTable("presets", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  description: varchar("description", { length: 500 }),
  ownerId: varchar("owner_id", { length: 36 }).references(() => users.id),
  chain: json("chain").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export const effectDefinitions = mysqlTable("effect_definitions", {
  id: varchar("id", { length: 64 }).primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  definition: json("definition").notNull(),
});

export const deviceState = mysqlTable("device_state", {
  deviceId: varchar("device_id", { length: 36 }).primaryKey().references(() => devices.id),
  currentPresetId: varchar("current_preset_id", { length: 36 }).references(() => presets.id),
  cpuPercent: float("cpu_percent"),
  temperatureC: float("temperature_c"),
  sampleRate: int("sample_rate"),
  bufferSize: int("buffer_size"),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});
