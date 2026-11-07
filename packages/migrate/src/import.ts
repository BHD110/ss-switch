import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type {
  DivergenceInfo,
  Fidelity,
  HostId,
  HostStatus,
  ImportPlan,
  ImportPlanRequest,
  ImportResult,
  SessionDetail,
  SessionRef,
  StoredPart,
  UndoResult,
} from "@bridge/contracts";
import type { HostAdapter, HostPaths, HostWriter } from "@bridge/hosts";
import { qoderProjectSlug } from "@bridge/hosts";
import type { BridgeStore } from "@bridge/store";
import { verifyHost } from "@bridge/verify";

import { backupTargets, createBackup, restoreBackup } from "./backup";

export interface ImportContext {
  paths: HostPaths;
  adapters: Record<HostId, HostAdapter>;
  writers: Partial<Record<HostId, HostWriter>>;
  store: BridgeStore;
  backupRoot: string;
  hostStatuses?: () => Promise<HostStatus[]>;
}

export async function planImport(
  ctx: ImportContext,
  request: ImportPlanRequest,
): Promise<ImportPlan> {
  const blockers: string[] = [];
  const targetHost = request.targetHost;
  const writer = ctx.writers[targetHost];
  const sourceAdapter = ctx.adapters[request.source.host];
  const detail = await readSource(sourceAdapter, request.source);
  const fidelity = fidelityFor(detail);
  const dropped = droppedParts(detail, targetHost);
  const toolCalls = detail.parts.filter(
    (part) => part.kind === "tool_call" && Boolean(part.toolCallId),
  ).length;

  if (!writer) blockers.push(`${targetHost} is read-only in this version`);
  if (request.source.host === targetHost)
    blockers.push("Source and target must be different hosts");

  let overwriteAllowed = request.mode === "new_copy";
  let overwriteReason: string | undefined;
  if (request.mode === "overwrite") {
    if (!request.targetNativeId) {
      overwriteAllowed = false;
      overwriteReason = "No target session was selected";
    } else if (!writer) {
      overwriteAllowed = false;
      overwriteReason = "Target host is read-only";
    } else {
      const touching = ctx.store.lineageTouching(targetHost, request.targetNativeId);
      if (!touching) {
        overwriteAllowed = false;
        overwriteReason = "This session was not imported by Bridge, so it cannot be overwritten";
      } else {
        const expected =
          touching.side === "dst" ? touching.lineage.dstFpAtImport : touching.lineage.srcFpAtImport;
        // Lineage fingerprints are content hashes from the host adapter, so
        // both sides can be compared the same way after any write.
        const current = await ctx.adapters[targetHost].deepFingerprint(request.targetNativeId);
        if (!current) {
          overwriteAllowed = false;
          overwriteReason = "Target session no longer exists";
        } else if (current !== expected) {
          overwriteAllowed = false;
          overwriteReason =
            "Target has changed since the import (new messages). Use “new copy” or archive it first";
        } else {
          overwriteAllowed = true;
        }
      }
    }
  }

  if (writer) {
    try {
      await writer.assertSchema();
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
    if (await writer.isBusy()) {
      blockers.push(`${targetHost} appears to be running; close it and retry (writes are refused)`);
    }
  }

  const backupNote =
    targetHost === "qoder"
      ? "Backs up main.sqlite (+wal/shm) and the target JSONL before writing"
      : "Backs up db.sqlite and tasks-index.sqlite (+wal/shm) before writing";

  return {
    source: request.source,
    targetHost,
    mode: request.mode,
    fidelity,
    turns: detail.turns.length,
    parts: detail.parts.length,
    toolCalls,
    dropped,
    warnings: detail.warnings,
    blockers,
    overwriteAllowed,
    overwriteReason,
    backupNote,
    writeBlockedReason: blockers[0],
  };
}

export async function runImport(
  ctx: ImportContext,
  request: ImportPlanRequest,
): Promise<ImportResult> {
  const txId = `tx_${randomUUID()}`;
  const plan = await planImport(ctx, request);
  if (plan.blockers.length || (request.mode === "overwrite" && !plan.overwriteAllowed)) {
    return {
      ok: false,
      targetHost: request.targetHost,
      txId,
      fidelity: plan.fidelity,
      turns: plan.turns,
      parts: plan.parts,
      warnings: plan.warnings,
      error: [...plan.blockers, plan.overwriteReason].filter(Boolean).join("; "),
    };
  }
  const writer = ctx.writers[request.targetHost]!;
  const _adapter = ctx.adapters[request.targetHost];
  const sourceAdapter = ctx.adapters[request.source.host];
  const detail = await readSource(sourceAdapter, request.source);
  const sourceFingerprint = (await sourceAdapter.deepFingerprint(request.source.nativeId)) ?? "";

  const targetNativeId =
    request.mode === "overwrite" && request.targetNativeId
      ? request.targetNativeId
      : request.targetHost === "qoder"
        ? randomUUID()
        : `sess_${randomUUID()}`;

  const targetJsonl =
    request.targetHost === "qoder"
      ? join(
          ctx.paths.qoderConfigDir,
          "projects",
          qoderProjectSlug(request.cwd || detail.session.cwd || process.cwd()),
          `${targetNativeId}.jsonl`,
        )
      : undefined;

  const backupFiles = backupTargets(
    request.targetHost,
    ctx.paths,
    targetJsonl ? [targetJsonl] : [],
  );
  const backup = await createBackup(ctx.backupRoot, txId, backupFiles);
  ctx.store.createTx({
    id: txId,
    kind: request.mode === "overwrite" ? "overwrite" : "import",
    src: `${request.source.host}:${request.source.nativeId}`,
    dst: `${request.targetHost}:${targetNativeId}`,
    backupDir: backup.dir,
  });

  const touching = ctx.store.lineageTouching(request.targetHost, targetNativeId);
  let lineageId = touching?.lineage.id;
  const lineageSide = touching?.side;
  if (!lineageId) {
    lineageId = ctx.store.addLineage({
      srcSessionId: request.source.nativeId,
      srcHost: request.source.host,
      dstSessionId: targetNativeId,
      dstHost: request.targetHost,
      mode: request.mode === "overwrite" ? "overwrite_same" : "copy",
      fidelity: plan.fidelity,
      srcFpAtImport: sourceFingerprint,
      dstFpAtImport: "",
      createdAt: Date.now(),
    });
  }

  ctx.store.updateTx(txId, "writing");
  try {
    const outcome =
      request.mode === "overwrite"
        ? await writer.overwrite(detail, targetNativeId)
        : await writer.insert(detail, {
            nativeId: targetNativeId,
            title: request.title || detail.session.title,
            cwd: request.cwd || detail.session.cwd,
            lineageId,
            sourceHost: request.source.host,
            sourceSessionId: request.source.nativeId,
            sourceModel: detail.session.model,
          });

    ctx.store.updateTx(txId, "verifying", { steps: outcome.steps });
    const verification = verifyHost(request.targetHost, ctx.paths, targetNativeId, {
      messages: outcome.nativeMessages,
      parts: outcome.parts,
      turns: outcome.turns,
      file: targetJsonl,
    });
    if (!verification.ok) {
      throw new Error(
        `Post-write verification failed: ${verification.checks
          .filter((check) => !check.ok)
          .map((check) => `${check.name} (${check.detail})`)
          .join(", ")}`,
      );
    }

    const writtenFingerprint =
      (await ctx.adapters[request.targetHost].deepFingerprint(targetNativeId)) ?? "";
    if (lineageId) {
      // A write on the original side updates the source fingerprint; a write on
      // the imported side updates the destination fingerprint.
      if (lineageSide === "src")
        ctx.store.updateLineageSrcFingerprint(lineageId, writtenFingerprint);
      else ctx.store.updateLineageDstFingerprint(lineageId, writtenFingerprint);
    }
    ctx.store.updateTx(txId, "committed", { steps: outcome.steps });
    await refreshIndex(ctx, request.targetHost);

    return {
      ok: true,
      targetHost: request.targetHost,
      targetNativeId,
      lineageId,
      txId,
      fidelity: outcome.fidelity,
      turns: outcome.turns,
      parts: outcome.parts,
      backupDir: backup.dir,
      openCommand: outcome.openCommand ?? writer.openCommand(targetNativeId),
      warnings: [...plan.warnings, ...outcome.warnings],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.store.updateTx(txId, "failed", { error: message });
    try {
      if (request.mode === "new_copy") writer.remove(targetNativeId);
      else await restoreBackup(backup);
    } catch {
      // A failed rollback is visible through the tx row; never hide the original error.
    }
    return {
      ok: false,
      targetHost: request.targetHost,
      txId,
      fidelity: plan.fidelity,
      turns: plan.turns,
      parts: plan.parts,
      backupDir: backup.dir,
      warnings: plan.warnings,
      error: message,
    };
  }
}

export async function undoImport(ctx: ImportContext, txId: string): Promise<UndoResult> {
  const tx = ctx.store.getTx(txId);
  if (!tx) return { ok: false, txId, removedTargets: [], error: "Unknown transaction" };
  if (tx.state !== "committed") {
    return {
      ok: false,
      txId,
      removedTargets: [],
      error: `Only committed imports can be undone (state: ${tx.state})`,
    };
  }
  const [hostRaw, ...rest] = (tx.dst ?? "").split(":");
  const nativeId = rest.join(":");
  const host = hostRaw as HostId;
  const writer = ctx.writers[host];
  if (!writer || !nativeId) {
    return { ok: false, txId, removedTargets: [], error: "Target is not writable" };
  }
  if (await writer.isBusy()) {
    return {
      ok: false,
      txId,
      removedTargets: [],
      error: "Target host is running; close it before undoing",
    };
  }
  try {
    if (tx.kind === "overwrite" && tx.backupDir) {
      const { readManifest } = await import("./backup");
      const manifest = await readManifest(tx.backupDir);
      if (!manifest) throw new Error("Backup manifest is missing");
      await restoreBackup(manifest);
    } else {
      writer.remove(nativeId);
    }
    ctx.store.updateTx(txId, "rolled_back");
    await refreshIndex(ctx, host);
    return { ok: true, txId, removedTargets: [`${host}:${nativeId}`] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.store.updateTx(txId, "failed", { error: message });
    return { ok: false, txId, removedTargets: [], error: message };
  }
}

export async function detectDivergence(ctx: ImportContext): Promise<DivergenceInfo[]> {
  const found: DivergenceInfo[] = [];
  for (const lineage of ctx.store.listLineage()) {
    const [srcHost, srcId] = splitRef(lineage.srcSessionId, lineage.srcHost);
    const [dstHost, dstId] = splitRef(lineage.dstSessionId, lineage.dstHost);
    const srcAdapter = ctx.adapters[srcHost];
    const dstAdapter = ctx.adapters[dstHost];
    if (!srcAdapter || !dstAdapter) continue;
    const srcNow = (await srcAdapter.deepFingerprint(srcId)) ?? "";
    const dstNow = (await dstAdapter.deepFingerprint(dstId)) ?? "";
    const srcChanged = Boolean(srcNow) && srcNow !== lineage.srcFpAtImport;
    const dstChanged = Boolean(dstNow) && dstNow !== lineage.dstFpAtImport;
    if (srcChanged && !ctx.store.hasDivergence(lineage.id, "src", srcNow, dstNow)) {
      ctx.store.recordDivergence(lineage.id, "src", srcNow, dstNow);
    }
    if (dstChanged && !ctx.store.hasDivergence(lineage.id, "dst", srcNow, dstNow)) {
      ctx.store.recordDivergence(lineage.id, "dst", srcNow, dstNow);
    }
    if (srcChanged || dstChanged) {
      found.push({
        lineageId: lineage.id,
        srcHost: lineage.srcHost,
        dstHost: lineage.dstHost,
        srcChanged,
        dstChanged,
        detectedAt: Date.now(),
      });
    }
  }
  return found;
}

async function readSource(adapter: HostAdapter, ref: SessionRef): Promise<SessionDetail> {
  return adapter.read(ref.nativeId);
}

function splitRef(value: string, fallbackHost: HostId): [HostId, string] {
  const [maybeHost, ...rest] = value.split(":");
  if (
    rest.length &&
    (maybeHost === "qoder" ||
      maybeHost === "codex" ||
      maybeHost === "zcode" ||
      maybeHost === "workbuddy")
  ) {
    return [maybeHost, rest.join(":")];
  }
  return [fallbackHost, value];
}

function fidelityFor(detail: SessionDetail): Fidelity {
  const risky = detail.parts.some(
    (part) => part.kind !== "text" && part.kind !== "reasoning" && part.kind !== "tool_call",
  );
  if (risky || detail.warnings.length) return "adapted";
  const hasTools = detail.parts.some((part) => part.kind === "tool_call");
  return hasTools ? "adapted" : "high";
}

const DROPPABLE: Record<HostId, Set<StoredPart["kind"]>> = {
  qoder: new Set(["image", "file", "timeline", "step", "system"]),
  zcode: new Set(["image", "system"]),
  codex: new Set(),
  workbuddy: new Set(),
};

function droppedParts(
  detail: SessionDetail,
  targetHost: HostId,
): { kind: string; count: number; reason: string }[] {
  const droppable = DROPPABLE[targetHost] ?? new Set();
  const counts = new Map<string, number>();
  for (const part of detail.parts) {
    if (droppable.has(part.kind)) {
      counts.set(part.kind, (counts.get(part.kind) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([kind, count]) => ({
    kind,
    count,
    reason:
      targetHost === "qoder" ? "Qoder has no equivalent part" : "ZCode has no equivalent part",
  }));
}

async function refreshIndex(ctx: ImportContext, host: HostId): Promise<void> {
  try {
    const adapter = ctx.adapters[host];
    if (!adapter) return;
    const sessions = await adapter.scan();
    ctx.store.replaceSessionIndex(
      host,
      sessions,
      sessions.map((session) => session.nativeId),
    );
  } catch {
    // The next explicit scan repairs the index; a failed refresh is not a failed import.
  }
}

/** Status for both writers, used by the UI to disable confirm buttons. */
export async function writerReadiness(
  ctx: ImportContext,
): Promise<Partial<Record<HostId, { ready: boolean; reason?: string }>>> {
  const result: Partial<Record<HostId, { ready: boolean; reason?: string }>> = {};
  for (const [host, writer] of Object.entries(ctx.writers) as [HostId, HostWriter][]) {
    try {
      await writer.assertSchema();
      if (await writer.isBusy()) {
        result[host] = { ready: false, reason: "Host is running; close it to write" };
      } else {
        result[host] = { ready: true };
      }
    } catch (error) {
      result[host] = {
        ready: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return result;
}

export function backupExists(path: string | undefined): boolean {
  return Boolean(path && existsSync(path));
}
