import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type Dirent, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SessionDetail, StoredPart } from "@bridge/contracts";
import { resolvePaths, workbuddyDbPath, workbuddyProjectsDir } from "../paths";
import { DatabaseSync } from "../sqlite";
import type { HostPaths, HostWriter, WriteOptions, WriteOutcome } from "../types";
import { sha256File, workbuddyProjectSlug } from "../util";

const execFileAsync = promisify(execFile);

const REQUIRED_SESSION_COLUMNS = [
  "id",
  "cwd",
  "user_id",
  "title",
  "status",
  "created_at",
  "updated_at",
  "deleted_at",
  "model",
  "last_activity_at",
  "transport",
  "session_settings",
];

interface SessionDefaults {
  userId: string;
  model: string;
}

export class WorkbuddyWriter implements HostWriter {
  readonly targetHost = "workbuddy" as const;
  private defaultsCache?: SessionDefaults;
  /** A recent write of our own must not look like a running app. */
  private lastWriteAt = 0;

  constructor(readonly paths: HostPaths) {}

  private dbPath(): string {
    return workbuddyDbPath(this.paths);
  }

  async assertSchema(): Promise<void> {
    if (!existsSync(this.paths.workbuddyHome)) {
      throw new Error("WorkBuddy data directory not found; open WorkBuddy once, then retry");
    }
    if (!existsSync(this.dbPath())) {
      throw new Error("WorkBuddy database not found; open WorkBuddy once, then retry");
    }
    const db = new DatabaseSync(this.dbPath(), { readOnly: true });
    try {
      const columns = new Set(
        db
          .prepare("PRAGMA table_info(sessions)")
          .all()
          .map((row) => String((row as { name: string }).name)),
      );
      if (!columns.size) {
        throw new Error("Unsupported WorkBuddy schema: sessions table is missing");
      }
      for (const column of REQUIRED_SESSION_COLUMNS) {
        if (!columns.has(column)) {
          throw new Error(`Unsupported WorkBuddy schema: sessions.${column} is missing`);
        }
      }
    } finally {
      db.close();
    }
  }

  async isBusy(): Promise<boolean> {
    if (resolve(this.paths.workbuddyHome) !== resolve(resolvePaths().workbuddyHome)) return false;
    if (process.platform === "win32") {
      try {
        const { stdout } = await execFileAsync("tasklist", [
          "/FI",
          "IMAGENAME eq WorkBuddy.exe",
          "/NH",
        ]);
        if (stdout.toLowerCase().includes("workbuddy.exe")) return true;
      } catch {
        // tasklist unavailable; fall through to the freshness heuristic.
      }
    }
    if (Date.now() - this.lastWriteAt < 30_000) return false;
    for (const candidate of [this.dbPath(), `${this.dbPath()}-wal`]) {
      try {
        if (Date.now() - statSync(candidate).mtimeMs < 20_000) return true;
      } catch {
        // Missing files mean no recent activity.
      }
    }
    return false;
  }

  async fingerprint(nativeId: string): Promise<string | undefined> {
    const file = await this.findTranscript(nativeId);
    return file ? sha256File(file) : undefined;
  }

  async insert(detail: SessionDetail, options: WriteOptions = {}): Promise<WriteOutcome> {
    await this.assertSchema();
    const nativeId = options.nativeId ?? randomUUID();
    const cwd = options.cwd || detail.session.cwd || process.cwd();
    const title = options.title || detail.session.title || "Imported session";
    const createdAt = detail.session.createdAt || Date.now();
    const updatedAt = detail.session.updatedAt || createdAt;
    const file = this.transcriptPath(cwd, nativeId);
    if (existsSync(file)) throw new Error(`Target transcript already exists: ${file}`);

    const defaults = this.defaults();
    const plan = buildTranscript(detail, nativeId, cwd, title, {
      lineageId: options.lineageId,
      sourceHost: options.sourceHost ?? detail.session.host,
      sourceSessionId: options.sourceSessionId ?? detail.session.nativeId,
      sourceModel: detail.session.model,
    });
    await writeFileAtomic(file, plan.lines);
    try {
      const db = new DatabaseSync(this.dbPath());
      db.exec("PRAGMA busy_timeout=4000");
      try {
        db.exec("BEGIN IMMEDIATE");
        db.prepare(
          `INSERT INTO sessions(
             id, cwd, user_id, title, status, created_at, updated_at, deleted_at, is_playground,
             model, last_activity_at, transport, session_settings, unread)
           VALUES(?,?,?,?,'completed',?,?, NULL,0,?,?,'local',?,0)`,
        ).run(
          nativeId,
          cwd,
          defaults.userId,
          title,
          createdAt,
          updatedAt,
          defaults.model,
          updatedAt,
          JSON.stringify({
            bridgeVersion: 1,
            bridgeLineage: options.lineageId ?? null,
            bridgeSourceHost: options.sourceHost ?? detail.session.host,
            bridgeSourceSessionId: options.sourceSessionId ?? detail.session.nativeId,
            bridgeSourceModel: detail.session.model ?? null,
          }),
        );
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Already rolled back.
        }
        throw error;
      } finally {
        db.close();
      }
    } catch (error) {
      await rm(file, { force: true });
      throw error;
    }
    await this.ensureSessionDir(cwd, nativeId);

    this.lastWriteAt = Date.now();
    return {
      nativeId,
      fidelity: "adapted",
      turns: plan.turnCount,
      parts: plan.partCount,
      nativeMessages: plan.messageCount,
      dropped: plan.dropped,
      warnings: plan.warnings,
      nativeFile: file,
      openCommand: `workbuddy --resume ${nativeId}`,
      steps: [
        { step: "transcript", detail: file },
        { step: "sessions", detail: `${this.dbPath()} sessions` },
      ],
    };
  }

  async overwrite(detail: SessionDetail, nativeId: string): Promise<WriteOutcome> {
    await this.assertSchema();
    const file = await this.findTranscript(nativeId);
    if (!file) throw new Error("Target WorkBuddy session no longer exists");
    const cwd = detail.session.cwd || process.cwd();
    const title = detail.session.title || "Imported session";
    const createdAt = detail.session.createdAt || Date.now();
    const updatedAt = detail.session.updatedAt || createdAt;
    const plan = buildTranscript(detail, nativeId, cwd, title, { overwrite: true });

    await writeFileAtomic(file, plan.lines);
    const db = new DatabaseSync(this.dbPath());
    db.exec("PRAGMA busy_timeout=4000");
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = db.prepare("SELECT session_settings FROM sessions WHERE id=?").get(nativeId) as
        | { session_settings: string }
        | undefined;
      if (!row) throw new Error("Target WorkBuddy session no longer exists");
      if (!isBridgeOwned(row.session_settings)) {
        throw new Error("Refusing to overwrite a session Bridge did not create");
      }
      db.prepare("UPDATE sessions SET title=?, updated_at=?, last_activity_at=? WHERE id=?").run(
        title,
        updatedAt,
        updatedAt,
        nativeId,
      );
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      throw error;
    } finally {
      db.close();
    }

    this.lastWriteAt = Date.now();
    return {
      nativeId,
      fidelity: "adapted",
      turns: plan.turnCount,
      parts: plan.partCount,
      nativeMessages: plan.messageCount,
      dropped: plan.dropped,
      warnings: plan.warnings,
      nativeFile: file,
      openCommand: `workbuddy --resume ${nativeId}`,
      steps: [{ step: "transcript", detail: "replaced in place after fingerprint check" }],
    };
  }

  remove(nativeId: string): void {
    const db = new DatabaseSync(this.dbPath());
    db.exec("PRAGMA busy_timeout=4000");
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = db.prepare("SELECT session_settings FROM sessions WHERE id=?").get(nativeId) as
        | { session_settings: string }
        | undefined;
      if (!row) {
        db.exec("ROLLBACK");
        return;
      }
      if (!isBridgeOwned(row.session_settings)) {
        throw new Error("Refusing to delete a session Bridge did not create");
      }
      db.prepare("DELETE FROM sessions WHERE id=?").run(nativeId);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      throw error;
    } finally {
      db.close();
    }
    const file = this.findTranscriptSync(nativeId);
    if (file) rmSyncSafe(file);
    for (const dir of this.sessionDirsSync(nativeId)) {
      rmTreeSafe(dir);
    }
  }

  openCommand(nativeId: string): string {
    return `workbuddy --resume ${nativeId}`;
  }

  // ------------------------------------------------------------------ files

  private transcriptPath(cwd: string, nativeId: string): string {
    return join(workbuddyProjectsDir(this.paths), workbuddyProjectSlug(cwd), `${nativeId}.jsonl`);
  }

  private async findTranscript(nativeId: string): Promise<string | undefined> {
    const root = workbuddyProjectsDir(this.paths);
    let projects: Dirent[];
    try {
      projects = await readdir(root, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const candidate = join(root, project.name, `${nativeId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  private findTranscriptSync(nativeId: string): string | undefined {
    const root = workbuddyProjectsDir(this.paths);
    for (const name of safeReaddir(root)) {
      const candidate = join(root, name, `${nativeId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  private sessionDirsSync(nativeId: string): string[] {
    const root = workbuddyProjectsDir(this.paths);
    return safeReaddir(root)
      .map((name) => join(root, name, nativeId))
      .filter((candidate) => existsSync(candidate));
  }

  private async ensureSessionDir(cwd: string, nativeId: string): Promise<void> {
    try {
      await mkdir(
        join(workbuddyProjectsDir(this.paths), workbuddyProjectSlug(cwd), nativeId, "tool-results"),
        { recursive: true },
      );
    } catch {
      // The desktop recreates the folder on first open; a failure is not fatal.
    }
  }

  private defaults(): SessionDefaults {
    if (this.defaultsCache) return this.defaultsCache;
    let userId = "";
    let model = "auto";
    try {
      const db = new DatabaseSync(this.dbPath(), { readOnly: true });
      try {
        const row = db
          .prepare(
            `SELECT user_id, model FROM sessions
             WHERE deleted_at IS NULL AND user_id <> ''
             ORDER BY COALESCE(last_activity_at, updated_at) DESC LIMIT 1`,
          )
          .get() as { user_id: string; model: string | null } | undefined;
        if (row?.user_id) userId = row.user_id;
        if (row?.model) model = row.model;
      } finally {
        db.close();
      }
    } catch {
      // Fall back to the values below.
    }
    this.defaultsCache = { userId: userId || "bridge-import", model };
    return this.defaultsCache;
  }
}

interface PlannedTranscript {
  lines: string;
  turnCount: number;
  partCount: number;
  messageCount: number;
  dropped: WriteOutcome["dropped"];
  warnings: string[];
}

interface Provenance {
  lineageId?: string;
  sourceHost?: string;
  sourceSessionId?: string;
  sourceModel?: string;
  overwrite?: boolean;
}

function buildTranscript(
  detail: SessionDetail,
  nativeId: string,
  cwd: string,
  title: string,
  provenance: Provenance,
): PlannedTranscript {
  const createdAt = detail.session.createdAt || Date.now();
  const updatedAt = detail.session.updatedAt || createdAt;
  const records: Record<string, unknown>[] = [];
  const dropped: WriteOutcome["dropped"] = [];
  const warnings: string[] = [];
  let messageCount = 0;
  let partCount = 0;
  let parentId: string | undefined;

  const push = (record: Record<string, unknown>): string => {
    const id = randomUUID();
    records.push({
      id,
      ...(parentId ? { parentId } : {}),
      type: record.type,
      ...record,
      sessionId: nativeId,
      cwd,
    });
    parentId = id;
    return id;
  };

  push({
    type: "session-meta",
    timestamp: createdAt,
    meta: {
      "codebuddy.ai/hostKind": "unopted",
      bridge: {
        version: 1,
        lineageId: provenance.lineageId ?? null,
        sourceHost: provenance.sourceHost ?? detail.session.host,
        sourceSessionId: provenance.sourceSessionId ?? detail.session.nativeId,
        sourceModel: provenance.sourceModel ?? detail.session.model ?? null,
        importedAt: new Date().toISOString(),
      },
    },
  });
  push({ type: "ai-title", timestamp: createdAt, aiTitle: title });

  const turns = [...detail.turns].sort((a, b) => a.ord - b.ord);
  for (const turn of turns) {
    const turnParts = detail.parts
      .filter((part) => part.turnId === turn.id)
      .sort((a, b) => a.ord - b.ord);
    const userText = turnParts
      .filter((part) => part.kind === "text" && part.role === "user")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();
    const assistantParts = turnParts.filter((part) => part.role === "assistant");
    if (!userText && !assistantParts.length) continue;

    const started = turn.startedAt || createdAt;
    if (userText) {
      push({
        type: "message",
        timestamp: started,
        role: "user",
        content: [{ type: "input_text", text: userText }],
        providerData: { startsNewUserRequest: true, agent: "cli" },
      });
      messageCount += 1;
      partCount += 1;
    }

    for (const part of assistantParts) {
      switch (part.kind) {
        case "text": {
          if (!part.text) break;
          push({
            type: "message",
            timestamp: turn.endedAt || started,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: part.text }],
            providerData: { agent: "cli" },
          });
          messageCount += 1;
          partCount += 1;
          break;
        }
        case "reasoning": {
          if (!part.text) break;
          push({
            type: "reasoning",
            timestamp: turn.endedAt || started,
            content: [],
            rawContent: [{ type: "reasoning_text", text: part.text }],
            providerData: { agent: "cli" },
          });
          partCount += 1;
          break;
        }
        case "tool_call": {
          const callId = part.toolCallId ?? `call_${randomUUID()}`;
          const input = (part.payload as Record<string, unknown> | undefined)?.input ?? {};
          const args = JSON.stringify(input);
          push({
            type: "function_call",
            timestamp: turn.startedAt || started,
            callId,
            name: part.toolName ?? "tool",
            arguments: args,
            providerData: { agent: "cli", argumentsDisplayText: args },
          });
          partCount += 1;
          const result = toolResultOf(part);
          if (result !== undefined) {
            push({
              type: "function_call_result",
              timestamp: turn.endedAt || started,
              name: part.toolName ?? "tool",
              callId,
              status: part.toolState === "error" ? "error" : "completed",
              output: { type: "text", text: result },
            });
          }
          break;
        }
        case "image":
        case "attachment":
        case "file":
        case "timeline":
        case "step":
        case "system":
          increment(dropped, part.kind, 1, "not representable as a WorkBuddy transcript record");
          break;
        default:
          increment(dropped, part.kind, 1, "not representable as a WorkBuddy transcript record");
      }
    }
  }

  if (!messageCount) {
    push({
      type: "message",
      timestamp: createdAt,
      role: "user",
      content: [{ type: "input_text", text: title || "(empty session)" }],
      providerData: { startsNewUserRequest: true, agent: "cli" },
    });
    messageCount = 1;
    partCount = Math.max(partCount, 1);
    warnings.push("Source had no readable messages; wrote the title as a placeholder prompt");
  }

  // The desktop reads the newest ai-title record; keep it last so an imported
  // title wins over one derived from the body.
  push({ type: "ai-title", timestamp: updatedAt, aiTitle: title });

  return {
    lines: `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    turnCount: turns.length,
    partCount,
    messageCount,
    dropped,
    warnings,
  };
}

function toolResultOf(part: StoredPart): string | undefined {
  const payload = part.payload as Record<string, unknown> | undefined;
  const result = payload?.result ?? payload?.output;
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const text = (result as Record<string, unknown>).text;
    if (typeof text === "string") return text;
    return JSON.stringify(result).slice(0, 200_000);
  }
  return undefined;
}

function increment(
  list: WriteOutcome["dropped"],
  kind: string,
  count: number,
  reason: string,
): void {
  const existing = list.find((item) => item.kind === kind && item.reason === reason);
  if (existing) existing.count += count;
  else list.push({ kind, count, reason });
}

function isBridgeOwned(settings: string | null): boolean {
  try {
    const parsed = JSON.parse(settings ?? "{}") as { bridgeVersion?: number };
    return Boolean(parsed.bridgeVersion);
  } catch {
    return false;
  }
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${randomUUID()}`;
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function rmSyncSafe(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A file locked by the running host is removed on the next attempt.
  }
}

function rmTreeSafe(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best effort: only Bridge-owned session folders reach this branch.
  }
}
