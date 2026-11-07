import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, type Database } from "../sqlite";

import type {
  HostStatus,
  PartKind,
  SessionDetail,
  StoredPart,
  StoredSession,
  StoredTurn,
} from "@bridge/contracts";

import { qoderProjectsDir } from "../paths";
import type { HostAdapter, HostPaths } from "../types";
import { emptyCapabilities } from "../types";
import {
  asArray,
  cleanUserText,
  asRecord,
  fileMeta,
  firstString,
  num,
  orderByChain,
  qoderProjectSlug,
  readJsonl,
  sha256,
  sha256File,
  stableId,
  str,
  titleFromText,
  toMs,
  truncate,
} from "../util";

interface DesktopRow {
  session_id: string;
  title: string | null;
  cwd: string | null;
  model: string | null;
  updated_at: number | null;
  created_at: number | null;
  product_mode: string | null;
}

const MAX_SCAN_FILES = 5000;

export class QoderReader implements HostAdapter {
  readonly id = "qoder" as const;
  readonly displayName = "Qoder CN";
  readonly capabilities = emptyCapabilities({
    writable: true,
    desktopWritable: true,
    losses: [
      "Hooks and tool approval records are not replayed",
      "Attachments are kept as references, not binaries",
    ],
  });

  constructor(readonly paths: HostPaths) {}

  private get projectsDir(): string {
    return qoderProjectsDir(this.paths);
  }

  async status(known?: StoredSession[]): Promise<HostStatus> {
    const installed = existsSync(this.paths.qoderConfigDir);
    const sessions = known ?? (installed ? await this.scan() : []);
    const version = await this.readCliVersion();
    return {
      id: this.id,
      displayName: this.displayName,
      installed,
      detected: installed,
      root: this.paths.qoderConfigDir,
      version,
      sessionCount: sessions.length,
      writeReady: installed && existsSync(this.paths.qoderDesktopDb),
      writeBlockedReason: installed ? undefined : "Qoder config directory not found",
      capabilities: this.capabilities,
      lastScanAt: Date.now(),
    };
  }

  private async readCliVersion(): Promise<string | undefined> {
    const candidates = [join(this.paths.qoderConfigDir, "version"), join(this.paths.qoderConfigDir, "argv.json")];
    for (const candidate of candidates) {
      try {
        const text = await import("node:fs/promises").then((fs) => fs.readFile(candidate, "utf8"));
        if (!candidate.endsWith(".json")) return text.trim().slice(0, 40);
        const parsed = JSON.parse(text) as { version?: string };
        if (parsed.version) return parsed.version;
      } catch {
        // Not every install writes these files.
      }
    }
    return undefined;
  }

  private async listFiles(): Promise<{ path: string; nativeId: string; slug: string }[]> {
    const result: { path: string; nativeId: string; slug: string }[] = [];
    let projects: string[] = [];
    try {
      projects = await readdir(this.projectsDir);
    } catch {
      return result;
    }
    for (const slug of projects) {
      const dir = join(this.projectsDir, slug);
      let entries: string[] = [];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.toLowerCase().endsWith(".jsonl")) continue;
        result.push({ path: join(dir, entry), nativeId: entry.slice(0, -6), slug });
        if (result.length >= MAX_SCAN_FILES) return result;
      }
    }
    return result;
  }

  private desktopRows(): Map<string, DesktopRow> {
    const rows = new Map<string, DesktopRow>();
    if (!existsSync(this.paths.qoderDesktopDb)) return rows;
    let db: Database | undefined;
    try {
      db = new DatabaseSync(this.paths.qoderDesktopDb, { readOnly: true });
      const statement = db.prepare(
        `SELECT session_id, title, cwd, model, updated_at, created_at, product_mode
         FROM chat_sessions WHERE deleted_at IS NULL`,
      );
      for (const row of statement.all() as unknown as DesktopRow[]) rows.set(row.session_id, row);
    } catch {
      // A schema change must not hide CLI-only sessions.
    } finally {
      db?.close();
    }
    return rows;
  }

  async scan(): Promise<StoredSession[]> {
    const files = await this.listFiles();
    const desktop = this.desktopRows();
    const unique = new Map<string, { path: string; nativeId: string; slug: string }>();
    for (const file of files) unique.set(file.nativeId, file);
    const sessions: StoredSession[] = [];
    for (const file of unique.values()) {
      const meta = await fileMeta(file.path);
      const header = await this.readHeader(file.path, file.nativeId);
      const row = desktop.get(file.nativeId);
      const cwd = row?.cwd || header.cwd;
      const title = row?.title || header.title || titleFromText(header.firstUserText);
      sessions.push({
        id: stableId("qoder", file.nativeId),
        host: "qoder",
        nativeId: file.nativeId,
        cwd: cwd ?? "",
        title: title || file.nativeId,
        model: row?.model ?? header.model,
        createdAt: row?.created_at ?? header.createdAt ?? meta.mtimeMs,
        updatedAt: row?.updated_at ?? meta.mtimeMs,
        rawRef: file.path,
        fingerprint: `m:${meta.mtimeMs}:${meta.size}`,
        desktopVisible: Boolean(row),
        counts: { turns: 0, parts: 0 },
      });
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async readHeader(
    path: string,
    nativeId: string,
  ): Promise<{
    cwd?: string;
    model?: string;
    title?: string;
    firstUserText?: string;
    createdAt?: number;
  }> {
    let cwd: string | undefined;
    let model: string | undefined;
    let title: string | undefined;
    let firstUserText: string | undefined;
    let createdAt: number | undefined;
    let seen = 0;
    for await (const record of readJsonl(path)) {
      seen += 1;
      const type = record.type;
      if (type === "workspace-directories") {
        cwd ??= asArray(record.directories).find((value) => typeof value === "string") as
          | string
          | undefined;
      } else if (type === "runtime-config") {
        model ??= str(record.model);
      } else if (type === "custom-title") {
        title = firstString(record.title, (asRecord(record.customTitle) ?? {}).title);
      } else if (type === "user" && !firstUserText) {
        const message = asRecord(record.message);
        for (const block of asArray(message?.content)) {
          const text = str(asRecord(block)?.text);
          if (text && !isHarnessText(text)) {
            firstUserText = text;
            createdAt ??= toMs(record.timestamp);
            break;
          }
        }
      }
      if (seen >= 80 || (cwd && model && firstUserText)) break;
    }
    return { cwd, model, title, firstUserText, createdAt };
  }

  async read(nativeId: string): Promise<SessionDetail> {
    const session = (await this.scan()).find((item) => item.nativeId === nativeId);
    if (!session) throw new Error(`Qoder session not found: ${nativeId}`);
    const records: Record<string, unknown>[] = [];
    for await (const record of readJsonl(session.rawRef)) records.push(record);

    const ordered = orderByChain(
      records
        .filter((record) => typeof record.uuid === "string")
        .map((record) => ({
          uuid: record.uuid as string,
          parentUuid: typeof record.parentUuid === "string" ? record.parentUuid : null,
        })),
    );
    const byUuid = new Map(records.map((record) => [record.uuid as string, record]));

    const turns: StoredTurn[] = [];
    const parts: StoredPart[] = [];
    const warnings = new Set<string>();
    let currentTurn: StoredTurn | undefined;
    let ord = 0;
    let sidechains = 0;

    const pushPart = (
      kind: PartKind,
      role: StoredPart["role"],
      text: string | undefined,
      payload: unknown,
      extra: Partial<StoredPart> = {},
    ): void => {
      if (!currentTurn) {
        const fallback: StoredTurn = {
          id: `${session.id}:turn:0`,
          sessionId: session.id,
          ord: turns.length,
          startedAt: session.createdAt,
        };
        currentTurn = fallback;
        turns.push(fallback);
      }
      const part: StoredPart = {
        id: `${session.id}:part:${ord}`,
        sessionId: session.id,
        turnId: currentTurn.id,
        ord,
        kind,
        role,
        text,
        payload,
        hash: sha256(JSON.stringify(payload ?? text ?? "")),
        ...extra,
      };
      parts.push(part);
      ord += 1;
    };

    for (const chainEntry of ordered) {
      const record = byUuid.get(chainEntry.uuid);
      if (!record) continue;
      if (record.isSidechain === true) sidechains += 1;
      const type = record.type;

      if (type === "system") {
        const text = firstString(record.content, asRecord(record.compactMetadata) ? "Conversation compacted" : undefined);
        pushPart("system", "system", text, record);
        continue;
      }
      if (type === "attachment") {
        const attachment = asRecord(record.attachment) ?? {};
        // Context dumps (skill lists) are attachments without a file reference;
        // they would otherwise appear as fake user content on every turn.
        const file = firstString(attachment.path, attachment.filename, attachment.url);
        if (file) pushPart("attachment", "user", file, record);
        continue;
      }
      if (type === "user") {
        const message = asRecord(record.message);
        const blocks = asArray(message?.content).map(asRecord).filter(Boolean) as Record<
          string,
          unknown
        >[];
        const hasToolResult = blocks.some((block) => block.type === "tool_result");
        const human =
          record.humanInput !== undefined ||
          asRecord(record.origin)?.kind === "human" ||
          (!hasToolResult && record.userType === "external");
        if (human && !hasToolResult) {
          const text = blocks
            .filter((block) => block.type === "text")
            .map((block) => str(block.text) ?? "")
            .join("\n")
            .trim();
          currentTurn = {
            id: `${session.id}:turn:${turns.length}`,
            sessionId: session.id,
            ord: turns.length,
            startedAt: toMs(record.timestamp),
            outcome: undefined,
          };
          turns.push(currentTurn);
          if (text) pushPart("text", "user", text, record);
          for (const block of blocks) {
            if (block.type === "image") pushPart("image", "user", undefined, block);
          }
          continue;
        }
        for (const block of blocks) {
          if (block.type !== "tool_result") continue;
          const resultText = toolResultText(block.content);
          pushPart("tool_result", "tool", resultText, record, {
            toolCallId: str(block.tool_use_id),
            toolState: block.is_error === true ? "error" : "ok",
          });
        }
        continue;
      }
      if (type === "assistant") {
        const message = asRecord(record.message) ?? {};
        for (const rawBlock of asArray(message.content)) {
          const block = asRecord(rawBlock);
          if (!block) continue;
          switch (block.type) {
            case "text":
              pushPart("text", "assistant", str(block.text), block);
              break;
            case "thinking":
            case "redacted_thinking":
              pushPart("reasoning", "assistant", str(block.thinking) ?? "", block);
              break;
            case "tool_use":
              pushPart("tool_call", "assistant", str(block.name), block, {
                toolName: str(block.name),
                toolCallId: str(block.id),
                toolState: "ok",
                nativePartId: str(block.id),
              });
              break;
            case "image":
              pushPart("image", "assistant", undefined, block);
              break;
            default:
              warnings.add(`unknown content block: ${String(block.type)}`);
          }
        }
        if (currentTurn) currentTurn.endedAt = toMs(record.timestamp);
        continue;
      }
      if (type === "runtime-config") {
        const model = str(record.model);
        if (model) session.model = model;
      }
    }

    // Pair tool calls with their results so the UI shows one card per call.
    const results = new Map(
      parts.filter((part) => part.toolCallId && part.kind === "tool_result").map((part) => [
        part.toolCallId!,
        part,
      ]),
    );
    for (const part of parts) {
      if (part.kind !== "tool_call" || !part.toolCallId) continue;
      const result = results.get(part.toolCallId);
      if (!result) continue;
      part.toolState = result.toolState === "error" ? "error" : "ok";
      (part.payload as Record<string, unknown>).result = result.text;
      (part.payload as Record<string, unknown>).resultPartId = result.id;
      result.mergedInto = part.id;
    }

    for (const turn of turns) {
      const turnParts = parts.filter((part) => part.turnId === turn.id);
      const last = turnParts[turnParts.length - 1];
      turn.outcome =
        last?.toolState === "error"
          ? "failed"
          : last?.kind === "tool_call"
            ? "tool-calls"
            : "completed";
      turn.endedAt ??= last ? turn.endedAt ?? turn.startedAt : turn.startedAt;
    }

    if (sidechains) warnings.add(`${sidechains} sidechain records merged into the timeline`);
    session.counts = { turns: turns.length, parts: parts.length };
    return { session, turns, parts, warnings: [...warnings] };
  }

  async deepFingerprint(nativeId: string): Promise<string | undefined> {
    const session = (await this.scan()).find((item) => item.nativeId === nativeId);
    if (!session) return undefined;
    return sha256File(session.rawRef);
  }

  async isBusy(): Promise<boolean> {
    const wal = `${this.paths.qoderDesktopDb}-wal`;
    const meta = await fileMeta(wal);
    return Boolean(meta.mtimeMs) && Date.now() - meta.mtimeMs < 30_000;
  }

  /** Resolve the JSONL path a writer must create for this cwd. */
  targetPath(cwd: string, nativeId: string): string {
    return join(qoderProjectsDir(this.paths), qoderProjectSlug(cwd), `${nativeId}.jsonl`);
  }

  async sessionExists(nativeId: string): Promise<boolean> {
    const files = await this.listFiles();
    return files.some((file) => file.nativeId === nativeId);
  }

  async cliVersion(): Promise<string | undefined> {
    return this.readCliVersion();
  }
}

function isHarnessText(text: string): boolean {
  const head = text.trim().slice(0, 200).toLowerCase();
  return (
    head.startsWith("<system-reminder") ||
    head.startsWith("<user_info") ||
    head.startsWith("<environment_context") ||
    head.startsWith("<command-name") ||
    head.startsWith("<local-command")
  );
}

function toolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return truncateIfHuge(content);
  const blocks = asArray(content).map(asRecord).filter(Boolean) as Record<string, unknown>[];
  const text = blocks
    .map((block) => str(block.text) ?? (typeof block.content === "string" ? block.content : ""))
    .filter(Boolean)
    .join("\n");
  return text ? truncateIfHuge(text) : undefined;
}

function truncateIfHuge(text: string): string {
  const MAX = 400_000;
  return text.length > MAX ? `${text.slice(0, MAX)}\n…[truncated ${text.length - MAX} chars]` : text;
}

export function qoderReadNumber(value: unknown): number | undefined {
  return num(value);
}