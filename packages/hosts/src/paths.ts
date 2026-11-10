import { homedir } from "node:os";
import { join } from "node:path";

import type { HostPaths } from "./types";

/**
 * Roots may be overridden for tests and for alternate installs. Every reader
 * treats these as boundaries: nothing outside them is opened.
 */
export function resolvePaths(overrides: Partial<HostPaths> = {}): HostPaths {
  const home = overrides.home ?? process.env.BRIDGE_HOME ?? homedir();
  const appData =
    overrides.appData ??
    process.env.BRIDGE_APPDATA ??
    process.env.APPDATA ??
    join(home, "AppData", "Roaming");
  return {
    home,
    appData,
    qoderConfigDir:
      overrides.qoderConfigDir ?? process.env.BRIDGE_QODER_DIR ?? join(home, ".qoder-cn"),
    qoderDesktopDb:
      overrides.qoderDesktopDb ??
      process.env.BRIDGE_QODER_DB ??
      join(appData, "com.qodercn.app.stable", "main.sqlite"),
    codexHome: overrides.codexHome ?? process.env.BRIDGE_CODEX_HOME ?? join(home, ".codex"),
    zcodeHome: overrides.zcodeHome ?? process.env.BRIDGE_ZCODE_HOME ?? join(home, ".zcode"),
    workbuddyHome:
      overrides.workbuddyHome ?? process.env.BRIDGE_WORKBUDDY_HOME ?? join(home, ".workbuddy"),
  };
}

export function qoderProjectsDir(paths: HostPaths): string {
  return join(paths.qoderConfigDir, "projects");
}

export function qoderTasksDir(paths: HostPaths): string {
  return join(paths.qoderConfigDir, "tasks");
}

export function codexSessionsDir(paths: HostPaths): string {
  return join(paths.codexHome, "sessions");
}

export function codexDbPath(paths: HostPaths): string {
  return join(paths.codexHome, "sqlite", "codex.db");
}

export function codexIndexPath(paths: HostPaths): string {
  return join(paths.codexHome, "session_index.jsonl");
}

/** The live ZCode database path, used to decide whether process guards apply. */
export function zcodeDbPathForGuard(): string {
  return zcodeDbPath(resolvePaths());
}

export function zcodeDbPath(paths: HostPaths): string {
  return join(paths.zcodeHome, "cli", "db", "db.sqlite");
}

export function zcodeTasksDbPath(paths: HostPaths): string {
  return join(paths.zcodeHome, "v2", "tasks-index.sqlite");
}

export function workbuddyDbPath(paths: HostPaths): string {
  return join(paths.workbuddyHome, "workbuddy.db");
}

export function workbuddyProjectsDir(paths: HostPaths): string {
  return join(paths.workbuddyHome, "projects");
}

export function workbuddySessionsDir(paths: HostPaths): string {
  return join(paths.workbuddyHome, "sessions");
}
