/**
 * `node:sqlite` must be loaded through getBuiltinModule: the bundler rewrites
 * `require("node:sqlite")` to `require("sqlite")` for CommonJS output, which
 * Node cannot resolve. getBuiltinModule keeps the scheme intact at runtime.
 */
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const builtin = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

export const DatabaseSync: typeof DatabaseSyncType = builtin.DatabaseSync;

export type Database = DatabaseSyncType;
