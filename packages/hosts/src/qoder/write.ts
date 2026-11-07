import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync, type Database } from "../sqlite";
import { promisify } from "node:util";

import type { SessionDetail, StoredPart, StoredTurn } from "@bridge/contracts";

import { qoderProjectSlug } from "../util";
import { sha256 } from "../util";
import type { HostPaths, HostWriter, WriteOptions, WriteOutcome } from "../types";

const execFileAsync = promisify(execFile);

const REQUIRED_SESSION_COLUMNS = [
  "session_id",
  "session_kind",
  "conversation_mode",
  "product_mode",
  "title",
  "cwd",
  "model",
  "extra_json",
  "created_at",
  "updated_at",
  "execution_target_json",
  "message_envelope_version",
];

const REQUIRED_MESSAGE_COLUMNS = [
  "session_id",
  "message_id",
  "turn_id",
  "sequence",
  "payload_json",
  "status",
  "source",
  "created_at",
  "updated_at",
  "role",
  "payload_schema_version",
];

export class QoderWriter implements HostWriter {
  readonly targetHost = "qoder" as const;

  constructor(readonly paths: HostPaths) {}

  private dbPath(): string {
    return this.paths.qoderDesktopDb;
  }

  async assertSchema(): Promise<void> {
    if (!existsSync(this.dbPath())) {
      throw new Error("Qoder desktop database not found; open Qoder once, then retry");
    }
    const db = new DatabaseSync(this.dbPath(), { readOnly: true });
    try {
      const sessionCols = new Set(
        db.prepare("PRAGMA table_info(chat_sessions)").all().map((row) => String((row as { name: string }).name)),
      );
      for (const column of REQUIRED_SESSION_COLUMNS) {
        if (!sessionCols.has(column)) {
          throw new Error(`Unsupported Qoder schema: chat_sessions.${column} is missing`);
        }
      }
      const messageCols = new Set(
        db.prepare("PRAGMA table_info(chat_session_messages)").all().map((row) => String((row as { name: string }).name)),
      );
      for (const column of REQUIRED_MESSAGE_COLUMNS) {
        if (!messageCols.has(column)) {
          throw new Error(`Unsupported Qoder schema: chat_session_messages.${column} is missing`);
        }
      }
      const highest = db
        .prepare(
          "SELECT COALESCE(MAX(payload_schema_version),0) AS v, COALESCE(MAX(message_envelope_version),0) AS e FROM chat_session_messages m JOIN chat_sessions s USING(session_id)",
        )
        .get() as { v: number; e: number };
      if (highest.v > 2 || highest.e > 1) {
        throw new Error(
          `Qoder store is newer than this build (payload v${highest.v}, envelope v${highest.e}); writes are disabled`,
        );
      }
    } finally {
      db.close();
    }
  }

  async isBusy(): Promise<boolean> {
    if (process.platform === "win32") {
      try {
        const { stdout } = await execFileAsync("tasklist", ["/FI", "IMAGENAME eq Qoder CN.exe", "/NH"]);
        if (stdout.toLowerCase().includes("qoder cn.exe")) return true;
      } catch {
        // tasklist unavailable; fall through to WAL freshness.
      }
    }
    const { statSync } = await import("node:fs");
    for (const candidate of [this.dbPath(), `${this.dbPath()}-wal`]) {
      try {
        if (Date.now() - statSync(candidate).mtimeMs < 20_000) return true;
      } catch {
        // Missing file means no recent activity.
      }
    }
    return false;
  }

  async fingerprint(nativeId: string): Promise<string | undefined> {
    const file = await this.findFile(nativeId);
    const db = new DatabaseSync(this.dbPath(), { readOnly: true });
    try {
      const row = db
        .prepare("SELECT updated_at FROM chat_sessions WHERE session_id=? AND deleted_at IS NULL")
        .get(nativeId) as { updated_at: number } | undefined;
      const messages = db
        .prepare(
          `SELECT COUNT(*) AS c, COALESCE(MAX(updated_at),0) AS u,
                  COALESCE(SUM(payload_bytes),0) AS b
           FROM chat_session_messages WHERE session_id=?`,
        )
        .get(nativeId) as { c: number; u: number; b: number };
      if (!row && !file) return undefined;
      return sha256(`q|${row?.updated_at ?? 0}|${messages.c}|${messages.u}|${messages.b}|${file ?? ""}`);
    } finally {
      db.close();
    }
  }

  private async findFile(nativeId: string): Promise<string | undefined> {
    const projects = join(this.paths.qoderConfigDir, "projects");
    if (!existsSync(projects)) return undefined;
    const { readdir } = await import("node:fs/promises");
    for (const slug of await readdir(projects)) {
      const candidate = join(projects, slug, `${nativeId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  async insert(detail: SessionDetail, options: WriteOptions = {}): Promise<WriteOutcome> {
    const nativeId = options.nativeId ?? randomUUID();
    const cwd = options.cwd || detail.session.cwd || process.cwd();
    const title = options.title || detail.session.title || "Imported session";
    const plan = this.buildPlan(detail, nativeId, cwd, title, options);

    const file = join(
      this.paths.qoderConfigDir,
      "projects",
      qoderProjectSlug(cwd),
      `${nativeId}.jsonl`,
    );
    if (existsSync(file)) throw new Error(`Target session file already exists: ${file}`);
    await writeJsonlAtomic(file, plan.jsonl);

    const db = new DatabaseSync(this.dbPath());
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=4000");
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        `INSERT INTO chat_sessions(
           session_id, origin_session_id, session_kind, conversation_mode, product_mode, title, cwd,
           execution_kind, workspace_id, git_branch, model, permission_mode, additional_direcotries,
           extra_json, created_at, updated_at, execution_target_json, registration_json, archived,
           unread, message_envelope_version)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        nativeId,
        null,
        "standard",
        "normal",
        "coding",
        title,
        cwd,
        "local",
        null,
        null,
        null,
        "auto",
        "{}",
        JSON.stringify(plan.extra),
        detail.session.createdAt || Date.now(),
        detail.session.updatedAt || Date.now(),
        JSON.stringify({
          mode: "local",
          host: { id: "local", kind: "local", label: "Local" },
          workspace: { id: "", path: cwd },
        }),
        null,
        0,
        0,
        1,
      );
      this.insertMessages(db, nativeId, plan.messages);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      await rm(file, { force: true });
      throw error;
    } finally {
      db.close();
    }

    return {
      nativeId,
      fidelity: "adapted",
      turns: plan.turnCount,
      parts: plan.partCount,
      nativeMessages: plan.messages.length,
      dropped: plan.dropped,
      warnings: plan.warnings,
      openCommand: `qoderclicn --resume ${nativeId}`,
      steps: [
        { step: "jsonl", detail: file },
        { step: "desktop-db", detail: `${this.dbPath()} chat_sessions + chat_session_messages` },
      ],
    };
  }

  async overwrite(detail: SessionDetail, nativeId: string): Promise<WriteOutcome> {
    const cwd = detail.session.cwd || process.cwd();
    const title = detail.session.title || "Imported session";
    const plan = this.buildPlan(detail, nativeId, cwd, title, { overwrite: true });
    const file = join(
      this.paths.qoderConfigDir,
      "projects",
      qoderProjectSlug(cwd),
      `${nativeId}.jsonl`,
    );
    await writeJsonlAtomic(file, plan.jsonl);

    const db = new DatabaseSync(this.dbPath());
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=4000");
    try {
      db.exec("BEGIN IMMEDIATE");
      const owned = db
        .prepare("SELECT extra_json FROM chat_sessions WHERE session_id=?")
        .get(nativeId) as { extra_json: string } | undefined;
      if (!owned) throw new Error("Target Qoder session no longer exists");
      db.prepare("DELETE FROM chat_session_search_segments WHERE session_id=?").run(nativeId);
      db.prepare("DELETE FROM chat_session_messages WHERE session_id=?").run(nativeId);
      db.prepare(
        "UPDATE chat_sessions SET title=?, cwd=?, extra_json=?, updated_at=?, message_envelope_version=1 WHERE session_id=?",
      ).run(
        title,
        cwd,
        JSON.stringify(plan.extra),
        detail.session.updatedAt || Date.now(),
        nativeId,
      );
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
    return {
      nativeId,
      fidelity: "adapted",
      turns: plan.turnCount,
      parts: plan.partCount,
      nativeMessages: plan.messages.length,
      dropped: plan.dropped,
      warnings: plan.warnings,
      openCommand: `qoderclicn --resume ${nativeId}`,
      steps: [{ step: "jsonl+db", detail: "replaced in place after fingerprint check" }],
    };
  }

  remove(nativeId: string): void {
    const db = new DatabaseSync(this.dbPath());
    db.exec("PRAGMA foreign_keys=ON");
    try {
      const row = db
        .prepare("SELECT extra_json FROM chat_sessions WHERE session_id=?")
        .get(nativeId) as { extra_json: string } | undefined;
      if (!row) return;
      if (!isBridgeOwned(row.extra_json)) {
        throw new Error("Refusing to delete a session Bridge did not create");
      }
      db.prepare("DELETE FROM chat_sessions WHERE session_id=?").run(nativeId);
    } finally {
      db.close();
    }
    // Best-effort file removal; a missing file means the row was already gone.
    const projects = join(this.paths.qoderConfigDir, "projects");
    for (const slug of safeReaddir(projects)) {
      const candidate = join(projects, slug, `${nativeId}.jsonl`);
      if (existsSync(candidate)) {
        rmSyncSafe(candidate);
      }
    }
  }

  openCommand(nativeId: string): string {
    return `qoderclicn --resume ${nativeId}`;
  }

  // ------------------------------------------------------------------ plan

  private buildPlan(
    detail: SessionDetail,
    nativeId: string,
    cwd: string,
    title: string,
    options: WriteOptions,
  ): {
    jsonl: string;
    extra: Record<string, unknown>;
    messages: PlannedMessage[];
    turnCount: number;
    partCount: number;
    dropped: WriteOutcome["dropped"];
    warnings: string[];
  } {
    const createdAt = detail.session.createdAt || Date.now();
    const updatedAt = detail.session.updatedAt || Date.now();
    const model = options.sourceModel || detail.session.model;
    const jsonlRecords: Record<string, unknown>[] = [
      { type: "workspace-directories", sessionId: nativeId, directories: [cwd] },
      {
        type: "runtime-config",
        sessionId: nativeId,
        model: model ?? null,
        reasoningEffort: null,
        contextWindow: null,
        generation: null,
        timestamp: createdAt,
      },
    ];
    const messages: PlannedMessage[] = [];
    const dropped: WriteOutcome["dropped"] = [];
    const warnings: string[] = [];
    let sequence = 1;
    let leafUuid: string | null = null;
    let partCount = 0;

    const turns = [...detail.turns].sort((a, b) => a.ord - b.ord);
    for (const turn of turns) {
      const turnParts = detail.parts.filter((part) => part.turnId === turn.id).sort((a, b) => a.ord - b.ord);
      const userText = turnParts
        .filter((part) => part.kind === "text" && part.role === "user")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
      const userParts = turnParts.filter((part) => part.role === "user" && part.kind !== "text");
      const assistantParts = turnParts.filter((part) => part.role === "assistant");
      if (!userText && !assistantParts.length) {
        const skipped = turnParts.length;
        if (skipped) increment(dropped, "empty turn", skipped, "no user or assistant text");
        continue;
      }

      const userUuid = randomUUID();
      const startedAt = iso(turn.startedAt || createdAt);
      if (userText) {
        jsonlRecords.push({
          type: "user",
          uuid: userUuid,
          timestamp: startedAt,
          message: { role: "user", content: [{ type: "text", text: userText }] },
          permissionMode: "auto",
          origin: { kind: "human" },
          promptId: userUuid,
          humanInput: { text: userText, mode: "prompt" },
          requestSetId: userUuid,
          parentUuid: leafUuid,
          isSidechain: false,
          cwd,
          sessionId: nativeId,
          userType: "external",
          entrypoint: "cli",
          version: "1.1.79",
        });
        leafUuid = userUuid;

        const payloadParts = [
          { id: `${userUuid}:text`, type: "text", text: userText },
          ...userParts
            .filter((part) => part.kind === "attachment")
            .map((part) => ({
              id: `${userUuid}:attachment:${part.ord}`,
              type: "attachment",
              text: part.text ?? "",
            })),
        ];
        messages.push({
          messageId: userUuid,
          turnId: userUuid,
          sequence: sequence++,
          role: "user",
          source: "host-projection",
          payload: {
            issueId: null,
            attachments: [],
            selectedSkillNames: [],
            selectedPluginIds: [],
            selectedConnectorIds: [],
            selectedAgentNames: [],
            selectedCapabilityCommands: [],
            referencedChatSessions: [],
            parts: payloadParts,
          },
          createdAt: turn.startedAt || createdAt,
          updatedAt: turn.endedAt || turn.startedAt || createdAt,
        });
        partCount += payloadParts.length;
      }

      const assistantUuid = randomUUID();
      const dbParts: Record<string, unknown>[] = [];
      const jsonlContent: Record<string, unknown>[] = [];
      let lastTextId: string | undefined;
      for (const part of assistantParts) {
        const converted = toQoderPart(part, assistantUuid, turn);
        if (!converted) {
          increment(dropped, part.kind, 1, "not representable as a Qoder part");
          continue;
        }
        dbParts.push(converted.db);
        if (converted.jsonl) jsonlContent.push(converted.jsonl);
        if (converted.kind === "text") lastTextId = String(converted.db.id);
      }
      if (!jsonlContent.length) {
        if (assistantParts.length) warnings.push("A turn had no assistant content after conversion");
        continue;
      }
      if (userText) {
        jsonlRecords.push({
          type: "assistant",
          uuid: assistantUuid,
          timestamp: iso(turn.endedAt || turn.startedAt || createdAt),
          message: {
            id: `resp_${sha256(assistantUuid).slice(0, 24)}`,
            type: "message",
            role: "assistant",
            model: model ?? null,
            stop_reason: jsonlContent.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
            stop_sequence: null,
            content: jsonlContent,
          },
          modelSource: "system",
          parentUuid: userUuid,
          isSidechain: false,
          cwd,
          sessionId: nativeId,
          userType: "external",
          entrypoint: "cli",
          version: "1.1.79",
        });
        leafUuid = assistantUuid;
      }

      messages.push({
        messageId: `assistant:${userUuid}`,
        turnId: userUuid,
        sequence: sequence++,
        role: "assistant",
        source: "sdk-projection",
        payload: {
          forkBoundaryProviderId: null,
          requestSetId: null,
          resultUuid: assistantUuid,
          completedAt: iso(turn.endedAt || turn.startedAt || createdAt),
          durationMs: Math.max(0, (turn.endedAt || 0) - (turn.startedAt || 0)),
          turnMetrics: { durationMs: 0, turnCount: dbParts.length },
          parts: dbParts,
          finalTextId: lastTextId ?? null,
        },
        createdAt: turn.startedAt || createdAt,
        updatedAt: turn.endedAt ?? Date.now(),
      });
      partCount += dbParts.length;

      // Tool results become the next user record, exactly as the CLI writes them.
      if (userText) {
        for (const part of assistantParts) {
          if (part.kind !== "tool_call") continue;
          const resultText = toolResultOf(part);
          if (resultText === undefined) continue;
          const resultUuid = randomUUID();
          jsonlRecords.push({
            type: "user",
            uuid: resultUuid,
            timestamp: iso(part.payload && (part.payload as Record<string, unknown>).completedAt
              ? Date.parse(String((part.payload as Record<string, unknown>).completedAt))
              : turn.endedAt || turn.startedAt || createdAt),
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: part.toolCallId ?? part.id, content: resultText },
              ],
            },
            sourceToolAssistantUUID: assistantUuid,
            promptId: resultUuid,
            parentUuid: leafUuid,
            isSidechain: false,
            cwd,
            sessionId: nativeId,
            userType: "external",
            entrypoint: "cli",
            version: "1.1.79",
          });
          leafUuid = resultUuid;
        }
      }
    }

    if (!messages.length) {
      // A session with no text is still a valid row; keep one empty user turn so
      // the desktop can open it instead of showing a broken entry.
      const uuid = randomUUID();
      messages.push({
        messageId: uuid,
        turnId: uuid,
        sequence: 1,
        role: "user",
        source: "host-projection",
        payload: {
          issueId: null,
          attachments: [],
          selectedSkillNames: [],
          selectedPluginIds: [],
          selectedConnectorIds: [],
          selectedAgentNames: [],
          selectedCapabilityCommands: [],
          referencedChatSessions: [],
          parts: [{ id: `${uuid}:text`, type: "text", text: "(empty session)" }],
        },
        createdAt,
        updatedAt,
      });
      warnings.push("Source had no readable messages; wrote an empty placeholder turn");
    }

    const lastPrompt = [...messages].reverse().find((message) => message.role === "user");
    const lastPromptText = lastPrompt?.payload.parts?.find((part) => typeof part.text === "string")?.text;
    jsonlRecords.push({
      type: "last-prompt",
      sessionId: nativeId,
      lastPrompt: typeof lastPromptText === "string" ? lastPromptText : title,
    });
    if (leafUuid) {
      jsonlRecords.push({
        type: "active-leaf",
        sessionId: nativeId,
        leafUuid,
        explicit: true,
        timestamp: updatedAt,
      });
    }

    const extra: Record<string, unknown> = {
      source: "bridge",
      cliSessionReady: true,
      modelSource: { kind: "system" },
      titleResolved: true,
      titleSource: "custom",
      titleRevision: 0,
      provisionalTitle: title,
      bridgeVersion: 1,
      bridgeLineage: options.lineageId ?? null,
      bridgeSourceHost: options.sourceHost ?? detail.session.host,
      bridgeSourceSessionId: options.sourceSessionId ?? detail.session.nativeId,
      bridgeSourceModel: model ?? null,
    };

    return {
      jsonl: jsonlRecords.map((record) => JSON.stringify(record)).join("\n") + "\n",
      extra,
      messages,
      turnCount: turns.length,
      partCount,
      dropped,
      warnings,
    };
  }

  private insertMessages(db: Database, nativeId: string, messages: PlannedMessage[]): void {
    const messageStmt = db.prepare(
      `INSERT INTO chat_session_messages(
         session_id, message_id, turn_id, sequence, payload_json, status, source, created_at,
         updated_at, role, subtype, fork_availability, turn_started_at, is_compaction_boundary,
         has_visible_content, payload_bytes, payload_hash, payload_schema_version, feedback_revision)
       VALUES(?,?,?,?,?,'completed',?,?,?,?,NULL,'available',?,0,1,?,?,2,0)`,
    );
    const segmentStmt = db.prepare(
      `INSERT OR REPLACE INTO chat_session_search_segments(
         session_id, message_id, turn_id, sequence, position, segment_id, text, normalized_text)
       VALUES(?,?,?,?,?,?,?,?)`,
    );
    for (const message of messages) {
      const json = JSON.stringify(message.payload);
      messageStmt.run(
        nativeId,
        message.messageId,
        message.turnId,
        message.sequence,
        json,
        message.source,
        message.createdAt,
        message.updatedAt,
        message.role,
        message.createdAt,
        Buffer.byteLength(json, "utf8"),
        createHash("sha256").update(json).digest("hex"),
      );
      let position = 0;
      for (const part of message.payload.parts ?? []) {
        const text = part.text;
        if (typeof text !== "string" || !text) continue;
        segmentStmt.run(
          nativeId,
          message.messageId,
          message.turnId,
          message.sequence,
          position,
          `message:${message.messageId}:part:${part.id}:text:${position}:text`,
          text,
          text.toLowerCase(),
        );
        position += 1;
      }
    }
  }
}

interface PlannedMessage {
  messageId: string;
  turnId: string;
  sequence: number;
  role: "user" | "assistant";
  source: string;
  payload: {
    parts?: Record<string, unknown>[];
    [key: string]: unknown;
  };
  createdAt: number;
  updatedAt: number;
}

function toQoderPart(
  part: StoredPart,
  assistantUuid: string,
  turn: StoredTurn,
): { db: Record<string, unknown>; jsonl?: Record<string, unknown>; kind: string } | undefined {
  const rawPayload = part.payload as Record<string, unknown> | undefined;
  const startedAt = iso(
    typeof rawPayload?.startedAt === "string" ? rawPayload.startedAt : turn.startedAt,
  );
  const completedAt = iso(turn.endedAt || turn.startedAt);
  switch (part.kind) {
    case "text": {
      if (!part.text) return undefined;
      return {
        kind: "text",
        db: { id: `${assistantUuid}:text:${part.ord}`, type: "text", text: part.text, parentToolUseId: null },
        jsonl: { type: "text", text: part.text },
      };
    }
    case "reasoning": {
      if (!part.text) return undefined;
      return {
        kind: "reasoning",
        db: {
          id: `${assistantUuid}:thinking:${part.ord}`,
          type: "text",
          text: part.text,
          status: "completed",
          startedAt,
          completedAt,
          durationMs: 0,
          parentToolUseId: null,
        },
        jsonl: { type: "thinking", thinking: part.text, signature: "" },
      };
    }
    case "tool_call": {
      const input = (part.payload as Record<string, unknown> | undefined)?.input ?? {};
      const response = toolResultOf(part) ?? "";
      return {
        kind: "tool",
        db: {
          id: `tool:${part.toolCallId ?? part.id}`,
          type: "tool",
          tool: {
            id: part.toolCallId ?? part.id,
            name: part.toolName ?? "tool",
            input,
            status: part.toolState === "error" ? "error" : "completed",
            parentToolUseId: null,
            startedAt,
            response,
            shellOutput: { text: response },
            completedAt,
            durationMs: 0,
          },
        },
        jsonl: {
          type: "tool_use",
          id: part.toolCallId ?? part.id,
          name: part.toolName ?? "tool",
          input,
        },
      };
    }
    default:
      return undefined;
  }
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

function iso(value: number | string | undefined): string {
  const ms = typeof value === "number" ? value : value ? Date.parse(value) : Date.now();
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
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

function isBridgeOwned(extraJson: string): boolean {
  try {
    return JSON.parse(extraJson).source === "bridge";
  } catch {
    return false;
  }
}

async function writeJsonlAtomic(file: string, content: string): Promise<void> {
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