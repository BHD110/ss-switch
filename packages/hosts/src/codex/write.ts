import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { appendFile, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SessionDetail, StoredPart } from "@bridge/contracts";
import { codexDbPath, codexIndexPath, codexSessionsDir, resolvePaths } from "../paths";
import { type Database, DatabaseSync } from "../sqlite";
import type { HostPaths, HostWriter, WriteOptions, WriteOutcome } from "../types";
import { asRecord, codexRolloutDir, codexRolloutName, readJsonl, sha256File, str } from "../util";

const execFileAsync = promisify(execFile);

const REQUIRED_CATALOG_COLUMNS = [
  "host_id",
  "thread_id",
  "display_title",
  "source_created_at",
  "source_updated_at",
  "cwd",
  "source_kind",
  "observation_sequence",
  "missing_candidate",
  "thread_source",
  "source_recency_at",
];

interface RuntimeDefaults {
  model: string;
  cliVersion: string;
  originator: string;
  modelProvider: string;
  baseInstructions: string;
  contextWindow: number;
}

export class CodexWriter implements HostWriter {
  readonly targetHost = "codex" as const;
  private runtimeCache?: RuntimeDefaults;
  /** A recent write of our own must not look like a running app. */
  private lastWriteAt = 0;

  constructor(readonly paths: HostPaths) {}

  private dbPath(): string {
    return codexDbPath(this.paths);
  }

  async assertSchema(): Promise<void> {
    if (!existsSync(this.paths.codexHome)) {
      throw new Error("Codex data directory not found; open Codex once, then retry");
    }
    if (!existsSync(this.dbPath())) {
      throw new Error("Codex database not found; open Codex once, then retry");
    }
    const db = new DatabaseSync(this.dbPath(), { readOnly: true });
    try {
      const columns = new Set(
        db
          .prepare("PRAGMA table_info(local_thread_catalog)")
          .all()
          .map((row) => String((row as { name: string }).name)),
      );
      if (!columns.size) {
        throw new Error("Unsupported Codex schema: local_thread_catalog is missing");
      }
      for (const column of REQUIRED_CATALOG_COLUMNS) {
        if (!columns.has(column)) {
          throw new Error(`Unsupported Codex schema: local_thread_catalog.${column} is missing`);
        }
      }
      const migrations = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='codex_schema_migrations'",
        )
        .get();
      if (!migrations) {
        throw new Error(
          "Unsupported Codex schema: migration table is missing; writes are disabled",
        );
      }
    } finally {
      db.close();
    }
  }

  async isBusy(): Promise<boolean> {
    if (resolve(this.paths.codexHome) !== resolve(resolvePaths().codexHome)) return false;
    if (process.platform === "win32") {
      try {
        const { stdout } = await execFileAsync("tasklist", [
          "/FI",
          "IMAGENAME eq codex.exe",
          "/NH",
        ]);
        if (stdout.toLowerCase().includes("codex.exe")) return true;
      } catch {
        // tasklist unavailable; fall through to the freshness heuristic.
      }
    }
    if (Date.now() - this.lastWriteAt < 30_000) return false;
    const candidates = [this.dbPath(), `${this.dbPath()}-wal`, codexIndexPath(this.paths)];
    for (const candidate of candidates) {
      try {
        if (Date.now() - statSync(candidate).mtimeMs < 20_000) return true;
      } catch {
        // Missing files mean no recent activity.
      }
    }
    return false;
  }

  async fingerprint(nativeId: string): Promise<string | undefined> {
    const file = await this.findRollout(nativeId);
    return file ? sha256File(file) : undefined;
  }

  async insert(detail: SessionDetail, options: WriteOptions = {}): Promise<WriteOutcome> {
    await this.assertSchema();
    const nativeId = options.nativeId ?? randomUUID();
    const cwd = options.cwd || detail.session.cwd || process.cwd();
    const title = options.title || detail.session.title || "Imported session";
    const createdAt = detail.session.createdAt || Date.now();
    const file = this.rolloutPath(createdAt, nativeId);
    if (existsSync(file)) throw new Error(`Target rollout already exists: ${file}`);

    const runtime = await this.runtimeDefaults();
    const plan = buildRollout(detail, nativeId, cwd, title, runtime, {
      lineageId: options.lineageId,
      sourceHost: options.sourceHost ?? detail.session.host,
      sourceSessionId: options.sourceSessionId ?? detail.session.nativeId,
      sourceModel: detail.session.model,
    });

    await writeFileAtomic(file, plan.lines);
    try {
      await this.appendIndex(nativeId, title, detail.session.updatedAt || createdAt);
      this.upsertCatalog(nativeId, title, cwd, createdAt, detail.session.updatedAt || createdAt);
    } catch (error) {
      await rm(file, { force: true });
      try {
        await this.removeIndex(nativeId);
        this.deleteCatalog(nativeId);
      } catch {
        // The failed transaction row stays visible; never hide the first error.
      }
      throw error;
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
      openCommand: `codex resume ${nativeId}`,
      steps: [
        { step: "rollout", detail: file },
        { step: "session-index", detail: codexIndexPath(this.paths) },
        { step: "catalog", detail: `${this.dbPath()} local_thread_catalog` },
      ],
    };
  }

  async overwrite(detail: SessionDetail, nativeId: string): Promise<WriteOutcome> {
    await this.assertSchema();
    const file = await this.findRollout(nativeId);
    if (!file) throw new Error("Target Codex session no longer exists");
    const cwd = detail.session.cwd || process.cwd();
    const title = detail.session.title || "Imported session";
    const createdAt = detail.session.createdAt || Date.now();
    const runtime = await this.runtimeDefaults();
    const plan = buildRollout(detail, nativeId, cwd, title, runtime, { overwrite: true });

    await writeFileAtomic(file, plan.lines);
    await this.removeIndex(nativeId);
    await this.appendIndex(nativeId, title, detail.session.updatedAt || createdAt);
    this.upsertCatalog(nativeId, title, cwd, createdAt, detail.session.updatedAt || createdAt);

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
      openCommand: `codex resume ${nativeId}`,
      steps: [{ step: "rollout", detail: "replaced in place after fingerprint check" }],
    };
  }

  remove(nativeId: string): void {
    const file = this.findRolloutSync(nativeId);
    if (!file) return;
    if (!this.isBridgeOwnedSync(file)) {
      throw new Error("Refusing to delete a session Bridge did not create");
    }
    const db = new DatabaseSync(this.dbPath());
    db.exec("PRAGMA busy_timeout=4000");
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("DELETE FROM local_thread_catalog WHERE host_id='local' AND thread_id=?").run(
        nativeId,
      );
      db.prepare(
        "DELETE FROM local_thread_catalog_scan_entries WHERE host_id='local' AND thread_id=?",
      ).run(nativeId);
      db.exec("COMMIT");
      this.bumpCatalogRevision(db);
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
    rmSyncSafe(file);
    this.removeIndexSync(nativeId);
  }

  openCommand(nativeId: string): string {
    return `codex resume ${nativeId}`;
  }

  // ------------------------------------------------------------------ files

  private rolloutPath(createdAt: number, nativeId: string): string {
    return join(
      codexSessionsDir(this.paths),
      ...codexRolloutDir(createdAt),
      codexRolloutName(createdAt, nativeId),
    );
  }

  private async findRollout(nativeId: string): Promise<string | undefined> {
    const root = codexSessionsDir(this.paths);
    if (!existsSync(root)) return undefined;
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(`-${nativeId}.jsonl`) || entry.name === `${nativeId}.jsonl`) {
          found.push(full);
        }
      }
    };
    await walk(root);
    return newest(found);
  }

  private findRolloutSync(nativeId: string): string | undefined {
    const root = codexSessionsDir(this.paths);
    if (!existsSync(root)) return undefined;
    const visit = (dir: string, out: string[]): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const full = join(dir, name);
        try {
          if (statSync(full).isDirectory()) visit(full, out);
          else if (name.endsWith(`-${nativeId}.jsonl`)) out.push(full);
        } catch {
          // A file that vanished during the walk is simply not ours.
        }
      }
    };
    const out: string[] = [];
    visit(root, out);
    return newest(out);
  }

  private isBridgeOwnedSync(file: string): boolean {
    try {
      const first = readFileSync(file, "utf8").split("\n")[0] as string;
      const record = JSON.parse(first) as { payload?: { bridge?: { version?: number } } };
      return Boolean(record.payload?.bridge?.version);
    } catch {
      return false;
    }
  }

  private async appendIndex(nativeId: string, title: string, updatedAt: number): Promise<void> {
    const path = codexIndexPath(this.paths);
    await mkdir(dirname(path), { recursive: true });
    const line = `${JSON.stringify({
      id: nativeId,
      thread_name: title,
      updated_at: new Date(updatedAt || Date.now()).toISOString(),
    })}\n`;
    await appendFile(path, line, "utf8");
  }

  private async removeIndex(nativeId: string): Promise<void> {
    const path = codexIndexPath(this.paths);
    if (!existsSync(path)) return;
    const text = await readFile(path, "utf8");
    await writeFileAtomic(path, filterIndex(text, nativeId));
  }

  private removeIndexSync(nativeId: string): void {
    const path = codexIndexPath(this.paths);
    if (!existsSync(path)) return;
    try {
      writeFileSync(path, filterIndex(readFileSync(path, "utf8"), nativeId), "utf8");
    } catch {
      // The next import rewrites the index; a stale line is not session data.
    }
  }

  // ---------------------------------------------------------------- catalog

  private upsertCatalog(
    nativeId: string,
    title: string,
    cwd: string,
    createdAt: number,
    updatedAt: number,
  ): void {
    const db = new DatabaseSync(this.dbPath());
    db.exec("PRAGMA busy_timeout=4000");
    try {
      db.exec("BEGIN IMMEDIATE");
      const sequence = (
        db
          .prepare("SELECT COALESCE(MAX(observation_sequence),0)+1 AS s FROM local_thread_catalog")
          .get() as {
          s: number;
        }
      ).s;
      db.prepare(
        `INSERT INTO local_thread_catalog(
           host_id, thread_id, display_title, source_created_at, source_updated_at, cwd,
           source_kind, source_detail, model_provider, git_branch, observation_sequence,
           missing_candidate, thread_source, source_recency_at, pending_observed_title,
           project_id, conversation_origin, trial_conversation_type, chatgpt_async_status)
         VALUES('local',?,?,?,?,?,'vscode',NULL,'openai',NULL,?,0,'user',?,0,NULL,NULL,NULL,NULL)
         ON CONFLICT(host_id, thread_id) DO UPDATE SET
           display_title=excluded.display_title,
           source_updated_at=excluded.source_updated_at,
           cwd=excluded.cwd,
           missing_candidate=0,
           source_recency_at=excluded.source_recency_at`,
      ).run(nativeId, title, createdAt / 1000, updatedAt / 1000, cwd, sequence, updatedAt / 1000);
      db.prepare(
        `INSERT INTO local_thread_catalog_scan_entries(host_id, thread_id, removed)
         VALUES('local',?,0)
         ON CONFLICT(host_id, thread_id) DO UPDATE SET removed=0`,
      ).run(nativeId);
      db.exec("COMMIT");
      this.bumpCatalogRevision(db);
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
  }

  private bumpCatalogRevision(db: Database): void {
    try {
      db.prepare(
        "UPDATE local_thread_catalog_metadata SET catalog_revision=catalog_revision+1 WHERE id=1",
      ).run();
    } catch {
      // Older stores may not have the metadata row; visibility still works.
    }
  }

  private deleteCatalog(nativeId: string): void {
    if (!existsSync(this.dbPath())) return;
    const db = new DatabaseSync(this.dbPath());
    try {
      db.prepare("DELETE FROM local_thread_catalog WHERE host_id='local' AND thread_id=?").run(
        nativeId,
      );
    } finally {
      db.close();
    }
  }

  // ---------------------------------------------------------------- runtime

  /** Reuse the newest local session's model and base instructions. */
  private async runtimeDefaults(): Promise<RuntimeDefaults> {
    if (this.runtimeCache) return this.runtimeCache;
    const fallback: RuntimeDefaults = {
      model: "gpt-6.1-sol",
      cliVersion: "0.165.0",
      originator: "codex_work_desktop",
      modelProvider: "openai",
      baseInstructions: "",
      contextWindow: 258_400,
    };
    const root = codexSessionsDir(this.paths);
    const files = await newestRollouts(root, 20);
    for (const file of files) {
      let model: string | undefined;
      let cliVersion: string | undefined;
      let originator: string | undefined;
      let modelProvider: string | undefined;
      let baseInstructions: string | undefined;
      let contextWindow: number | undefined;
      let seen = 0;
      for await (const record of readJsonl(file)) {
        seen += 1;
        const payload = asRecord(record.payload);
        if (record.type === "session_meta" && payload) {
          cliVersion = str(payload.cli_version) ?? cliVersion;
          originator = str(payload.originator) ?? originator;
          modelProvider = str(payload.model_provider) ?? modelProvider;
          const instructions = asRecord(payload.base_instructions);
          baseInstructions = str(instructions?.text) ?? baseInstructions;
        } else if (record.type === "turn_context" && payload) {
          model = str(payload.model) ?? model;
          const window = payload.model_context_window;
          if (typeof window === "number") contextWindow = window;
        } else if (record.type === "event_msg" && payload?.type === "task_started") {
          const window = payload.model_context_window;
          if (typeof window === "number") contextWindow = window;
        }
        if (seen >= 60 && model) break;
      }
      if (model) {
        this.runtimeCache = {
          model,
          cliVersion: cliVersion ?? fallback.cliVersion,
          originator: originator ?? fallback.originator,
          modelProvider: modelProvider ?? fallback.modelProvider,
          baseInstructions: baseInstructions ?? "",
          contextWindow: contextWindow ?? fallback.contextWindow,
        };
        return this.runtimeCache;
      }
    }
    this.runtimeCache = fallback;
    return fallback;
  }
}

interface PlannedRollout {
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

function buildRollout(
  detail: SessionDetail,
  nativeId: string,
  cwd: string,
  title: string,
  runtime: RuntimeDefaults,
  provenance: Provenance,
): PlannedRollout {
  const createdAt = detail.session.createdAt || Date.now();
  const updatedAt = detail.session.updatedAt || createdAt;
  const records: Record<string, unknown>[] = [];
  const dropped: WriteOutcome["dropped"] = [];
  const warnings: string[] = [];
  let ordinal = 0;
  let messageCount = 0;
  let partCount = 0;

  const push = (record: Record<string, unknown>, ts = updatedAt): void => {
    records.push({ timestamp: new Date(ts).toISOString(), ordinal, ...record });
    ordinal += 1;
  };

  push(
    {
      type: "session_meta",
      payload: {
        session_id: nativeId,
        id: nativeId,
        timestamp: new Date(createdAt).toISOString(),
        cwd,
        runtime_workspace_roots: [cwd],
        originator: runtime.originator,
        cli_version: runtime.cliVersion,
        source: "vscode",
        thread_source: "user",
        model_provider: runtime.modelProvider,
        base_instructions: { text: runtime.baseInstructions },
        history_mode: "paginated",
        bridge: {
          version: 1,
          lineageId: provenance.lineageId ?? null,
          sourceHost: provenance.sourceHost ?? detail.session.host,
          sourceSessionId: provenance.sourceSessionId ?? detail.session.nativeId,
          sourceModel: provenance.sourceModel ?? detail.session.model ?? null,
          importedAt: new Date().toISOString(),
        },
      },
    },
    createdAt,
  );

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

    const turnId = randomUUID();
    const started = turn.startedAt || createdAt;
    const completed = turn.endedAt || started || createdAt;
    push(
      {
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: turnId,
          root_turn_id: turnId,
          started_at: Math.floor(started / 1000),
          model_context_window: runtime.contextWindow,
          collaboration_mode_kind: "default",
        },
      },
      started,
    );
    push(
      {
        type: "turn_context",
        payload: {
          turn_id: turnId,
          root_turn_id: turnId,
          cwd,
          approval_policy: "never",
          sandbox_policy: { type: "danger-full-access" },
          model: runtime.model,
          model_context_window: runtime.contextWindow,
        },
      },
      started,
    );

    if (userText) {
      const messageId = `msg_${randomUUID()}`;
      push(
        {
          type: "response_item",
          payload: {
            type: "message",
            id: messageId,
            role: "user",
            content: [{ type: "input_text", text: userText }],
          },
        },
        started,
      );
      // The desktop timeline also consumes item_completed events; write both
      // mirrors like a real turn so the imported session renders in full.
      push(
        {
          type: "event_msg",
          payload: {
            type: "item_completed",
            thread_id: nativeId,
            turn_id: turnId,
            item: {
              type: "UserMessage",
              id: messageId,
              client_id: randomUUID(),
              content: [{ type: "text", text: userText }],
            },
          },
        },
        started,
      );
      messageCount += 1;
      partCount += 1;
    }

    let lastAssistantText: string | undefined;
    for (const part of assistantParts) {
      switch (part.kind) {
        case "text": {
          if (!part.text) break;
          lastAssistantText = part.text;
          const messageId = `msg_${randomUUID()}`;
          push(
            {
              type: "response_item",
              payload: {
                type: "message",
                id: messageId,
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: part.text }],
              },
            },
            completed,
          );
          push(
            {
              type: "event_msg",
              payload: {
                type: "item_completed",
                thread_id: nativeId,
                turn_id: turnId,
                item: {
                  type: "AgentMessage",
                  id: messageId,
                  content: [{ type: "Text", text: part.text }],
                  phase: "final_answer",
                },
              },
            },
            completed,
          );
          messageCount += 1;
          partCount += 1;
          break;
        }
        case "reasoning": {
          if (!part.text) break;
          push(
            {
              type: "response_item",
              payload: {
                type: "reasoning",
                id: `rs_${randomUUID()}`,
                summary: [{ type: "summary_text", text: part.text }],
                content: [],
              },
            },
            completed,
          );
          partCount += 1;
          break;
        }
        case "tool_call": {
          const callId = part.toolCallId ?? `call_${randomUUID()}`;
          const input = (part.payload as Record<string, unknown> | undefined)?.input ?? {};
          push(
            {
              type: "response_item",
              payload: {
                type: "function_call",
                id: `fc_${randomUUID()}`,
                status: "completed",
                call_id: callId,
                name: part.toolName ?? "tool",
                arguments: JSON.stringify(input),
              },
            },
            started,
          );
          partCount += 1;
          const result = toolResultOf(part);
          if (result !== undefined) {
            push(
              {
                type: "response_item",
                payload: {
                  type: "function_call_output",
                  call_id: callId,
                  output: result,
                },
              },
              completed,
            );
          }
          break;
        }
        case "image":
        case "attachment":
        case "file":
        case "timeline":
        case "step":
        case "system":
          increment(dropped, part.kind, 1, "not representable as a Codex rollout record");
          break;
        default:
          increment(dropped, part.kind, 1, "not representable as a Codex rollout record");
      }
    }

    push(
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          root_turn_id: turnId,
          turn_id: turnId,
          last_agent_message: lastAssistantText ?? "",
          started_at: Math.floor(started / 1000),
          completed_at: Math.floor(completed / 1000),
          duration_ms: Math.max(0, completed - started),
        },
      },
      completed,
    );
  }

  if (!messageCount) {
    const turnId = randomUUID();
    push({
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: turnId,
        root_turn_id: turnId,
        started_at: Math.floor(createdAt / 1000),
        model_context_window: runtime.contextWindow,
        collaboration_mode_kind: "default",
      },
    });
    push({
      type: "turn_context",
      payload: { turn_id: turnId, root_turn_id: turnId, cwd, model: runtime.model },
    });
    push({
      type: "response_item",
      payload: {
        type: "message",
        id: `msg_${randomUUID()}`,
        role: "user",
        content: [{ type: "input_text", text: title || "(empty session)" }],
      },
    });
    messageCount = 1;
    partCount = Math.max(partCount, 1);
    warnings.push("Source had no readable messages; wrote the title as a placeholder prompt");
  }

  return {
    lines: `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    turnCount: turns.length,
    partCount,
    messageCount,
    dropped,
    warnings,
  };
}

async function newestRollouts(root: string, limit: number): Promise<string[]> {
  if (!existsSync(root)) return [];
  const found: { path: string; mtime: number }[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        try {
          found.push({ path: full, mtime: statSync(full).mtimeMs });
        } catch {
          // Ignore files deleted by a concurrent scan.
        }
      }
    }
  };
  await walk(root);
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((item) => item.path);
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

function rmSyncSafe(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A file locked by the running host is removed on the next attempt.
  }
}

/** Prefer the newest copy when a thread id appears in more than one rollout. */
function newest(paths: string[]): string | undefined {
  let best: string | undefined;
  let bestMs = -1;
  for (const path of paths) {
    try {
      const ms = statSync(path).mtimeMs;
      if (ms > bestMs) {
        best = path;
        bestMs = ms;
      }
    } catch {
      // Skip files that vanished mid-scan.
    }
  }
  return best;
}

function filterIndex(text: string, nativeId: string): string {
  const kept = text
    .split("\n")
    .filter((line) => line.trim())
    .filter((line) => {
      try {
        return str((JSON.parse(line) as { id?: unknown }).id) !== nativeId;
      } catch {
        return true;
      }
    });
  return kept.length ? `${kept.join("\n")}\n` : "";
}
