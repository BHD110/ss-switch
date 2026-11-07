import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { HostId } from "@bridge/contracts";
import type { HostPaths } from "@bridge/hosts";

export interface BackupFile {
  original: string;
  copy: string;
  existed: boolean;
  size: number;
  sha256?: string;
}

export interface BackupManifest {
  dir: string;
  createdAt: number;
  files: BackupFile[];
}

/** Files that must be copied before touching a host store. */
export function backupTargets(
  host: HostId,
  paths: HostPaths,
  extra: string[] = [],
): string[] {
  if (host === "qoder") {
    const db = paths.qoderDesktopDb;
    return [db, `${db}-wal`, `${db}-shm`, ...extra];
  }
  if (host === "zcode") {
    const db = join(paths.zcodeHome, "cli", "db", "db.sqlite");
    const index = join(paths.zcodeHome, "v2", "tasks-index.sqlite");
    return [db, `${db}-wal`, `${db}-shm`, index, `${index}-wal`, `${index}-shm`, ...extra];
  }
  return [...extra];
}

/**
 * Copy every rollback-relevant file before a write. A missing WAL is normal;
 * the manifest records that it did not exist so rollback can remove a new one.
 */
export async function createBackup(
  backupRoot: string,
  txId: string,
  files: string[],
): Promise<BackupManifest> {
  const dir = join(backupRoot, txId);
  await mkdir(dir, { recursive: true });
  const manifest: BackupManifest = { dir, createdAt: Date.now(), files: [] };
  let index = 0;
  for (const original of files) {
    if (!original) continue;
    let info: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      info = await stat(original);
    } catch {
      manifest.files.push({ original, copy: "", existed: false, size: 0 });
      continue;
    }
    if (!info.isFile()) continue;
    const copy = join(dir, `${String(index).padStart(2, "0")}-${basename(original)}`);
    await copyFile(original, copy);
    const digest = createHash("sha256").update(await readFile(copy)).digest("hex");
    manifest.files.push({ original, copy, existed: true, size: info.size, sha256: digest });
    index += 1;
  }
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

/** Restore a backup after a failure; only files Bridge touched are replaced. */
export async function restoreBackup(manifest: BackupManifest): Promise<void> {
  for (const file of manifest.files) {
    if (!file.existed) {
      await rm(file.original, { force: true });
      continue;
    }
    if (!file.copy) continue;
    await copyFile(file.copy, file.original);
  }
}

export async function readManifest(dir: string): Promise<BackupManifest | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as BackupManifest;
  } catch {
    return undefined;
  }
}