import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { statSync } from "node:fs";
import { basename } from "node:path";
import { DatabaseSync, type Database } from "../sqlite";
import { promisify } from "node:util";

import type { SessionDetail, StoredPart, StoredTurn } from "@bridge/contracts";

import { sha256 } from "../util";
import { zcodeDbPath, zcodeTasksDbPath } from "../paths";
import type { HostPaths, HostWriter, WriteOptions, WriteOutcome } from "../types";

const execFileAsync = promisify(execFile);
const KNOWN_SCHEMA = 24;

interface ModelSelection {
  providerId: string;
  modelId: string;
  options?: Record<string, unknown>;
}

export class ZcodeWriter implements HostWriter {
  readonly targetHost = "zcode" as const;
  private selectionCache?: ModelSelection;
  private permissionCache?: string;

  constructor(readonly paths: HostPaths) {}

  private dbPath(): string {
    return zcodeDbPath(this.paths);
  }

  async assertSchema(): Promise<void> {
    if (!existsSync(this.dbPath())) {
      throw new Error("ZCode database not found; open ZCode once, then retry");
    }
    const db = new DatabaseSync(this.dbPath(), { readOnly: true });
    try {
      const required: Record<string, string[]> = {
        session: ["id", "project_id", "slug", "directory", "title", "version", "time_created", "time_updated", "task_type"],
        message: ["id", "session_id", "time_created", "time_updated", "data", "sequence"],
        part: ["id", "message_id", "session_id", "time_created", "time_updated", "data", "sequence"],
        session_entry: ["id", "session_id", "type", "time_created", "time_updated", "data"],
      };
      for (const [table, columns] of Object.entries(required)) {
        const present = new Set(
          db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String((row as { name: string }).name)),
        );
        for (const column of columns) {
          if (!present.has(column)) {
            throw new Error(`Unsupported ZCode schema: ${table}.${column} is missing`);
          }
        }
      }
      const latest = db
        .prepare("SELECT id FROM schema_migration ORDER BY id DESC LIMIT 1")
        .get() as { id: string } | undefined;
      const number = latest ? Number(latest.id.slice(0, 4)) : 0;
      if (Number.isFinite(number) && number > KNOWN_SCHEMA) {
        throw new Error(
          `ZCode schema ${latest?.id} is newer than this build knows (${KNOWN_SCHEMA}); writes are disabled`,
        );
      }
    } finally {
      db.close();
    }
    const index = zcodeTasksDbPath(this.paths);
    if (existsSync(index)) {
      const tasksDb = new DatabaseSync(index, { readOnly: true });
      try {
        const columns = new Set(
          tasksDb.prepare("PRAGMA table_info(tasks)").all().map((row) => String((row as { name: string }).name)),
        );
        for (const column of ["workspace_key", "task_id", "title", "task_status", "meta_json"]) {
          if (!columns.has(column)) {
            throw new Error(`Unsupported ZCode task index schema: tasks.${column} is missing`);
          }
        }
      } finally {
        tasksDb.close();
      }
    }
  }

  async isBusy(): Promise<boolean> {
    if (process.platform === "win32") {
      try {
        const { stdout } = await execFileAsync("tasklist", ["/FI", "IMAGENAME eq ZCode.exe", "/NH"]);
        if (stdout.toLowerCase().includes("zcode.exe")) return true;
      } catch {
        // Fall through to the WAL heuristic.
      }
    }
    for (const candidate of [this.dbPath(), `${this.dbPath()}-wal`]) {
      try {
        if (Date.now() - statSync(candidate).mtimeMs < 20_000) return true;
      } catch {
        // No recent write.
      }
    }
    return false;
  }

  async fingerprint(nativeId: string): Promise<string | undefined> {
    if (!existsSync(this.dbPath())) return undefined;
    const db = new DatabaseSync(this.dbPath(), { readOnly: true });
    try {
      const row = db
        .prepare("SELECT time_updated, time_deleted FROM session WHERE id=?")
        .get(nativeId) as { time_updated: number; time_deleted: number | null } | undefined;
      if (!row || row.time_deleted) return undefined;
      const counts = db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM message WHERE session_id=?) AS m,
                  (SELECT COUNT(*) FROM part WHERE session_id=?) AS p,
                  (SELECT COALESCE(MAX(time_updated),0) FROM message WHERE session_id=?) AS t`,
        )
        .get(nativeId, nativeId, nativeId) as { m: number; p: number; t: number };
      let taskUpdated = 0;
      if (existsSync(zcodeTasksDbPath(this.paths))) {
        const index = new DatabaseSync(zcodeTasksDbPath(this.paths), { readOnly: true });
        try {
          const task = index
            .prepare("SELECT updated_at FROM tasks WHERE task_id=? ORDER BY updated_at DESC LIMIT 1")
            .get(nativeId) as { updated_at: number } | undefined;
          taskUpdated = task?.updated_at ?? 0;
        } finally {
          index.close();
        }
      }
      return sha256(`z|${row.time_updated}|${counts.m}|${counts.p}|${counts.t}|${taskUpdated}`);
    } finally {
      db.close();
    }
  }

  // --------------------------------------------------------------- insert

  async insert(detail: SessionDetail, options: WriteOptions = {}): Promise<WriteOutcome> {
    await this.assertSchema();
    const nativeId = options.nativeId ?? `sess_${randomUUID()}`;
    const cwd = options.cwd || detail.session.cwd || process.cwd();
    const title = options.title || detail.session.title || "Imported session";
    const plan = this.buildPlan(detail, nativeId, cwd, title);
    const { selection, permission } = this.reuseRuntime();

    const db = new DatabaseSync(this.dbPath());
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=4000");
    const now = Date.now();
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        `INSERT INTO session(id, project_id, workspace_id, parent_id, slug, directory, path, title,
                             version, permission, time_created, time_updated, task_type, title_source,
                             time_title_updated, trace_id, last_outcome)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        nativeId,
        projectId(cwd),
        null,
        null,
        nativeId,
        cwd,
        cwd,
        title,
        plan.version,
        JSON.stringify({ mode: permission }),
        detail.session.createdAt || now,
        detail.session.updatedAt || now,
        "interactive",
        "custom",
        now,
        randomUUID(),
        "completed",
      );
      this.insertMessages(db, nativeId, plan.messages);
      const entry = db.prepare(
        "INSERT INTO session_entry(id, session_id, type, time_created, time_updated, data) VALUES(?,?,?,?,?,?)",
      );
      entry.run(
        `${nativeId}:runtime-model-selection`,
        nativeId,
        "runtime/model_selection",
        now,
        now,
        JSON.stringify({ modelSelection: selection }),
      );
      entry.run(
        `${nativeId}:runtime-execution-state`,
        nativeId,
        "runtime/execution_state",
        now,
        now,
        JSON.stringify({ mode: permission, planEnabled: false }),
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

    this.upsertTask({
      nativeId,
      cwd,
      title,
      selection,
      createdAt: detail.session.createdAt || now,
      updatedAt: detail.session.updatedAt || now,
      searchableText: plan.searchableText,
    });

    return {
      nativeId,
      fidelity: "adapted",
      turns: plan.turnCount,
      parts: plan.partCount,
      nativeMessages: plan.messages.length,
      dropped: plan.dropped,
      warnings: plan.warnings,
      openCommand: `zcode --resume ${nativeId}`,
      steps: [
        { step: "main-db", detail: `${this.dbPath()} session/message/part/session_entry` },
        { step: "task-index", detail: `${zcodeTasksDbPath(this.paths)} tasks/projects/project_roots` },
      ],
    };
  }

  async overwrite(detail: SessionDetail, nativeId: string): Promise<WriteOutcome> {
    await this.assertSchema();
    const db = new DatabaseSync(this.dbPath());
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=4000");
    const now = Date.now();
    const cwd = detail.session.cwd || process.cwd();
    const title = detail.session.title || "Imported session";
    const plan = this.buildPlan(detail, nativeId, cwd, title);
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = db
        .prepare("SELECT id FROM session WHERE id=?")
        .get(nativeId) as { id: string } | undefined;
      if (!row) throw new Error("Target ZCode session no longer exists");
      db.prepare("DELETE FROM message WHERE session_id=?").run(nativeId);
      db.prepare(
        "UPDATE session SET title=?, time_updated=?, last_outcome='completed', title_source='custom' WHERE id=?",
      ).run(title, detail.session.updatedAt || now, nativeId);
      this.insertMessages(db, nativeId, plan.messages);
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
    this.upsertTask({
      nativeId,
      cwd,
      title,
      selection: this.reuseRuntime().selection,
      createdAt: detail.session.createdAt || now,
      updatedAt: detail.session.updatedAt || now,
      searchableText: plan.searchableText,
    });
    return {
      nativeId,
      fidelity: "adapted",
      turns: plan.turnCount,
      parts: plan.partCount,
      nativeMessages: plan.messages.length,
      dropped: plan.dropped,
      warnings: plan.warnings,
      openCommand: `zcode --resume ${nativeId}`,
      steps: [{ step: "main-db", detail: "messages replaced in place after fingerprint check" }],
    };
  }

  remove(nativeId: string): void {
    const db = new DatabaseSync(this.dbPath());
    db.exec("PRAGMA foreign_keys=ON");
    try {
      db.prepare("DELETE FROM session WHERE id=?").run(nativeId);
    } finally {
      db.close();
    }
    if (existsSync(zcodeTasksDbPath(this.paths))) {
      const index = new DatabaseSync(zcodeTasksDbPath(this.paths));
      try {
        index.prepare("DELETE FROM tasks WHERE task_id=?").run(nativeId);
      } finally {
        index.close();
      }
    }
  }

  openCommand(nativeId: string): string {
    return `zcode --resume ${nativeId}`;
  }

  // ------------------------------------------------------------------ plan

  private reuseRuntime(): { selection: ModelSelection; permission: string } {
    if (this.selectionCache) {
      return { selection: this.selectionCache, permission: this.permissionCache ?? "default" };
    }
    const fallback: ModelSelection = {
      providerId: "builtin:bigmodel-start-plan",
      modelId: "GLM-5.3",
      options: { reasoningLevel: "high" },
    };
    let selection = fallback;
    let permission = "default";
    try {
      const db = new DatabaseSync(this.dbPath(), { readOnly: true });
      try {
        const entry = db
          .prepare(
            `SELECT data FROM session_entry WHERE type='runtime/model_selection'
             ORDER BY time_updated DESC LIMIT 1`,
          )
          .get() as { data: string } | undefined;
        if (entry) {
          const parsed = JSON.parse(entry.data) as { modelSelection?: ModelSelection };
          if (parsed.modelSelection?.providerId && parsed.modelSelection.modelId) {
            selection = parsed.modelSelection;
          }
        }
        const permissionEntry = db
          .prepare(
            `SELECT data FROM session_entry WHERE type='runtime/execution_state'
             ORDER BY time_updated DESC LIMIT 1`,
          )
          .get() as { data: string } | undefined;
        if (permissionEntry) {
          const parsed = JSON.parse(permissionEntry.data) as { mode?: string };
          if (parsed.mode) permission = parsed.mode;
        } else {
          const row = db
            .prepare("SELECT permission FROM session WHERE permission IS NOT NULL ORDER BY time_updated DESC LIMIT 1")
            .get() as { permission: string } | undefined;
          if (row) {
            const parsed = JSON.parse(row.permission) as { mode?: string };
            if (parsed.mode) permission = parsed.mode;
          }
        }
      } finally {
        db.close();
      }
    } catch {
      // Fall back to the known-good builtin selection.
    }
    this.selectionCache = selection;
    this.permissionCache = permission;
    return { selection, permission };
  }

  private zcodeVersion(): string {
    try {
      const db = new DatabaseSync(this.dbPath(), { readOnly: true });
      try {
        const row = db
          .prepare("SELECT version FROM session ORDER BY time_updated DESC LIMIT 1")
          .get() as { version: string } | undefined;
        return row?.version ?? "0.17.0";
      } finally {
        db.close();
      }
    } catch {
      return "0.17.0";
    }
  }

  private buildPlan(
    detail: SessionDetail,
    nativeId: string,
    cwd: string,
    title: string,
  ): {
    messages: PlannedMessage[];
    turnCount: number;
    partCount: number;
    dropped: WriteOutcome["dropped"];
    warnings: string[];
    searchableText: string;
    version: string;
  } {
    const { selection } = this.reuseRuntime();
    const messages: PlannedMessage[] = [];
    const dropped: WriteOutcome["dropped"] = [];
    const warnings: string[] = [];
    const searchable: string[] = [];
    let sequence = 0;
    let partTotal = 0;
    let previousMessageId: string | undefined;
    const turns = [...detail.turns].sort((a, b) => a.ord - b.ord);

    for (const turn of turns) {
      const turnParts = detail.parts.filter((part) => part.turnId === turn.id).sort((a, b) => a.ord - b.ord);
      const userText = turnParts
        .filter((part) => part.kind === "text" && part.role === "user")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
      const assistantParts = turnParts.filter((part) => part.role === "assistant");
      if (!userText && !assistantParts.length) continue;

      const userMessageId = `msg_${Date.now().toString(36)}_${randomUUID()}`;
      if (userText) {
        searchable.push(userText);
        const parts: PlannedPart[] = [
          {
            id: `part_${Date.now().toString(36)}_${randomUUID()}_text`,
            data: {
              type: "text",
              text: userText,
              time: { start: turn.startedAt, end: turn.startedAt },
            },
          },
        ];
        messages.push({
          id: userMessageId,
          sequence: sequence++,
          role: "user",
          data: baseMessageData("user", turn.startedAt, cwd, previousMessageId, selection, {
            origin: "real_user",
            kind: "user_prompt",
            uiVisibility: "visible",
            providerVisibility: "visible",
            transcriptVisibility: "visible",
          }),
          parts,
        });
        partTotal += parts.length;
        previousMessageId = userMessageId;
      }

      if (!assistantParts.length) continue;
      const assistantMessageId = `msg_${Date.now().toString(36)}_${randomUUID()}`;
      const parts: PlannedPart[] = [
        { id: partId("step-start"), data: { type: "step-start" } },
      ];
      for (const part of assistantParts) {
        const converted = toZcodePart(part, turn);
        if (!converted) {
          increment(dropped, part.kind, 1, "not representable as a ZCode part");
          continue;
        }
        parts.push(converted);
      }
      parts.push({ id: partId("step-finish"), data: { type: "step-finish" } });
      if (parts.length <= 2) continue;
      messages.push({
        id: assistantMessageId,
        sequence: sequence++,
        role: "assistant",
        data: baseMessageData("assistant", turn.endedAt || turn.startedAt, cwd, userMessageId, selection, {
          origin: "agent_runtime",
          kind: "assistant_response",
          uiVisibility: "visible",
          providerVisibility: "visible",
          transcriptVisibility: "visible",
        }),
        parts,
      });
      partTotal += parts.length;
      previousMessageId = assistantMessageId;
    }

    if (!messages.length) {
      const id = `msg_${Date.now().toString(36)}_${randomUUID()}`;
      messages.push({
        id,
        sequence: 0,
        role: "user",
        data: baseMessageData("user", Date.now(), cwd, undefined, selection, {
          origin: "real_user",
          kind: "user_prompt",
          uiVisibility: "visible",
          providerVisibility: "visible",
          transcriptVisibility: "visible",
        }),
        parts: [{ id: partId("text"), data: { type: "text", text: "(empty session)", time: { start: Date.now(), end: Date.now() } } }],
      });
      partTotal += 1;
      warnings.push("Source had no readable messages; wrote an empty placeholder turn");
    }

    if (assistantPartsMissing(detail)) {
      warnings.push("Some assistant parts were dropped because ZCode has no equivalent");
    }
    return {
      messages,
      turnCount: turns.length,
      partCount: partTotal,
      dropped,
      warnings,
      searchableText: searchable.join("\n").slice(0, 8000) || title,
      version: this.zcodeVersion(),
    };
  }

  private insertMessages(
    db: Database,
    nativeId: string,
    messages: PlannedMessage[],
  ): void {
    const messageStmt = db.prepare(
      "INSERT INTO message(id, session_id, time_created, time_updated, data, sequence) VALUES(?,?,?,?,?,?)",
    );
    const partStmt = db.prepare(
      "INSERT INTO part(id, message_id, session_id, time_created, time_updated, data, sequence) VALUES(?,?,?,?,?,?,?)",
    );
    for (const message of messages) {
      const created = numberOr(message.data.time, "created") ?? Date.now();
      const completed = numberOr(message.data.time, "completed") ?? created;
      messageStmt.run(
        message.id,
        nativeId,
        created,
        completed,
        JSON.stringify(message.data),
        message.sequence,
      );
      let partSequence = 0;
      for (const part of message.parts) {
        partStmt.run(
          part.id,
          message.id,
          nativeId,
          created,
          completed,
          JSON.stringify(part.data),
          partSequence++,
        );
      }
    }
  }

  private upsertTask(input: {
    nativeId: string;
    cwd: string;
    title: string;
    selection: ModelSelection;
    createdAt: number;
    updatedAt: number;
    searchableText: string;
  }): void {
    const index = zcodeTasksDbPath(this.paths);
    if (!existsSync(index)) return;
    const db = new DatabaseSync(index);
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=4000");
    try {
      db.exec("BEGIN IMMEDIATE");
      const existingRoot = db
        .prepare("SELECT project_id FROM project_roots WHERE root_path=? LIMIT 1")
        .get(input.cwd) as { project_id: string } | undefined;
      let projectId = existingRoot?.project_id;
      if (!projectId) {
        const host = db.prepare("SELECT host_id FROM hosts WHERE host_id='local'").get();
        if (!host) db.prepare("INSERT INTO hosts(host_id, kind, position) VALUES('local','local',0)").run();
        const position = (
          db.prepare("SELECT COALESCE(MAX(position),-1)+1 AS p FROM projects").get() as { p: number }
        ).p;
        projectId = randomUUID();
        db.prepare(
          `INSERT INTO projects(project_id, host_id, name, name_overridden, position, pinned, deleted,
                                created_at, updated_at)
           VALUES(?,? ,?,0,?,0,0,?,?)`,
        ).run(projectId, "local", basename(input.cwd) || "project", position, input.createdAt, input.updatedAt);
        db.prepare(
          "INSERT INTO project_roots(project_id, root_path, position, is_primary) VALUES(?,?,0,1)",
        ).run(projectId, input.cwd);
      }
      const model = `${input.selection.providerId}/${input.selection.modelId}`;
      const provider = input.selection.providerId.split(":")[0] ?? "zcode";
      db.prepare(
        `INSERT INTO tasks(workspace_key, workspace_path, task_id, title, task_status, provider, mode,
                           model, created_at, updated_at, pinned, archived, deleted, title_overridden,
                           meta_json, searchable_text, host_id, root_path, project_id, sort_order,
                           cli_title, handoff_pending, cli_title_source, cli_created_at, cli_updated_at,
                           cli_last_outcome, cli_deleted)
         VALUES(?,?,?,?, 'completed', ?, 'build', ?, ?, ?, 0,0,0,0, ?, ?, 'local', ?, ?, 0,
                ?, 0, 'custom', ?, ?, 'completed', 0)
         ON CONFLICT(workspace_key, task_id) DO UPDATE SET
           title=excluded.title, task_status=excluded.task_status, model=excluded.model,
           updated_at=excluded.updated_at, meta_json=excluded.meta_json,
           searchable_text=excluded.searchable_text, project_id=excluded.project_id,
           cli_title=excluded.cli_title, cli_updated_at=excluded.cli_updated_at`,
      ).run(
        input.cwd,
        input.cwd,
        input.nativeId,
        input.title,
        provider,
        model,
        input.createdAt,
        input.updatedAt,
        JSON.stringify({
          taskId: input.nativeId,
          traceId: randomUUID(),
          title: input.title,
          workspacePath: input.cwd,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
          mode: "build",
          model,
          provider,
          status: "completed",
          bridgeImported: true,
        }),
        input.searchableText,
        input.cwd,
        projectId,
        input.title,
        input.createdAt,
        input.updatedAt,
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
  }
}

interface PlannedPart {
  id: string;
  data: Record<string, unknown>;
}

interface PlannedMessage {
  id: string;
  sequence: number;
  role: "user" | "assistant";
  data: Record<string, unknown>;
  parts: PlannedPart[];
}

function baseMessageData(
  role: "user" | "assistant",
  ts: number,
  cwd: string,
  parentId: string | undefined,
  selection: ModelSelection,
  semantics: Record<string, unknown>,
  text?: string,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    role,
    time: role === "user" ? { created: ts } : { created: ts, completed: ts },
    agent: "zcode-agent",
    path: { cwd, root: cwd },
    modelId: selection.modelId,
    providerId: selection.providerId,
    modelSelection: selection,
    mode: "build",
    planEnabled: false,
    finish: "completed",
    semantics,
  };
  if (parentId) data.parentID = parentId;
  if (text) data.summary = text.slice(0, 2000);
  return data;
}

function toZcodePart(part: StoredPart, turn: StoredTurn): PlannedPart | undefined {
  const start = turn.startedAt || Date.now();
  const end = turn.endedAt || start;
  switch (part.kind) {
    case "text":
      if (!part.text) return undefined;
      return { id: partId("text"), data: { type: "text", text: part.text, time: { start, end } } };
    case "reasoning":
      if (!part.text) return undefined;
      return {
        id: partId("reasoning"),
        data: { type: "reasoning", text: part.text, time: { start, end } },
      };
    case "tool_call": {
      const payload = part.payload as Record<string, unknown> | undefined;
      const response = toolOutputOf(part);
      return {
        id: partId("tool"),
        data: {
          type: "tool",
          callID: part.toolCallId ?? part.id,
          tool: part.toolName ?? "tool",
          state: {
            status: part.toolState === "error" ? "error" : "completed",
            input: payload?.input ?? {},
            output: response,
            title: part.toolName ?? "tool",
            metadata: {},
            time: { start, end },
          },
        },
      };
    }
    case "attachment":
    case "image":
      return {
        id: partId("file"),
        data: { type: "file", filename: part.text ?? "attachment", path: null, time: { start, end } },
      };
    case "timeline":
      return {
        id: partId("timeline"),
        data: { type: "timeline", timelineType: "bridge_import", display: "separator", status: "completed", time: { start, end } },
      };
    default:
      return undefined;
  }
}

function toolOutputOf(part: StoredPart): unknown {
  const payload = part.payload as Record<string, unknown> | undefined;
  return payload?.result ?? payload?.output ?? "";
}

function partId(kind: string): string {
  return `part_${Date.now().toString(36)}_${randomUUID()}_${kind}`;
}

function projectId(cwd: string): string {
  const slug = cwd.replace(/^.*[\\/]/, "").replace(/[^A-Za-z0-9_-]/g, "-").toLowerCase();
  return `proj_${slug || "default"}`;
}

function numberOr(record: unknown, key: string): number | undefined {
  if (!record || typeof record !== "object") return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
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

function assistantPartsMissing(detail: SessionDetail): boolean {
  return detail.parts.some(
    (part) => part.role === "assistant" && part.kind !== "text" && part.kind !== "reasoning" && part.kind !== "tool_call",
  );
}

export function zcodeContentHash(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}