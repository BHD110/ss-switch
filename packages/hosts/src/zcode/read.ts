import { existsSync } from "node:fs";
import type {
  HostStatus,
  PartKind,
  SessionDetail,
  StoredPart,
  StoredSession,
  StoredTurn,
} from "@bridge/contracts";
import { zcodeDbPath, zcodeTasksDbPath } from "../paths";
import { type Database, DatabaseSync } from "../sqlite";
import type { HostAdapter, HostPaths } from "../types";
import { emptyCapabilities } from "../types";
import {
  asArray,
  asRecord,
  firstString,
  num,
  sha256,
  stableId,
  str,
  titleFromText,
  truncate,
} from "../util";

interface SessionRow {
  id: string;
  project_id: string;
  workspace_id: string | null;
  parent_id: string | null;
  slug: string;
  directory: string;
  path: string | null;
  title: string;
  version: string;
  permission: string | null;
  time_created: number;
  time_updated: number;
  time_archived: number | null;
  task_type: string;
  title_source: string;
  trace_id: string | null;
  last_outcome: string | null;
  time_deleted: number | null;
}

interface MessageRow {
  id: string;
  sequence: number | null;
  time_created: number;
  time_updated: number;
  data: string;
}

interface PartRow {
  id: string;
  message_id: string;
  sequence: number | null;
  data: string;
}

export class ZcodeReader implements HostAdapter {
  readonly id = "zcode" as const;
  readonly displayName = "ZCode";
  readonly capabilities = emptyCapabilities({
    writable: true,
    desktopWritable: true,
    losses: ["Session entry checkpoints and usage metrics are not copied"],
  });

  constructor(readonly paths: HostPaths) {}

  private openDb(): Database {
    const path = zcodeDbPath(this.paths);
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout=3000");
    return db;
  }

  async status(known?: StoredSession[]): Promise<HostStatus> {
    const installed = existsSync(this.paths.zcodeHome);
    const dbExists = existsSync(zcodeDbPath(this.paths));
    let sessions: StoredSession[] = known ?? [];
    let version: string | undefined;
    if (dbExists) {
      sessions = known ?? (await this.scan());
      version = sessions.length
        ? ((await this.sessionVersion(sessions[0]!.nativeId)) ?? undefined)
        : undefined;
    }
    return {
      id: this.id,
      displayName: this.displayName,
      installed,
      detected: dbExists,
      root: this.paths.zcodeHome,
      version,
      sessionCount: sessions.length,
      writeReady: dbExists,
      capabilities: this.capabilities,
      lastScanAt: Date.now(),
    };
  }

  private sessionVersion(nativeId: string): string | undefined {
    try {
      const db = this.openDb();
      try {
        const row = db.prepare("SELECT version FROM session WHERE id=?").get(nativeId) as
          | { version: string }
          | undefined;
        return row?.version;
      } finally {
        db.close();
      }
    } catch {
      return undefined;
    }
  }

  private visibleTaskIds(): Set<string> {
    const ids = new Set<string>();
    const path = zcodeTasksDbPath(this.paths);
    if (!existsSync(path)) return ids;
    let db: Database | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      for (const row of db
        .prepare("SELECT task_id FROM tasks WHERE deleted=0")
        .all() as unknown as {
        task_id: string;
      }[]) {
        ids.add(row.task_id);
      }
    } catch {
      // The index is a cache; a missing row only changes the visibility badge.
    } finally {
      db?.close();
    }
    return ids;
  }

  async scan(): Promise<StoredSession[]> {
    if (!existsSync(zcodeDbPath(this.paths))) return [];
    const visible = this.visibleTaskIds();
    const db = this.openDb();
    try {
      const rows = db
        .prepare(
          `SELECT s.id, s.project_id, s.workspace_id, s.parent_id, s.slug, s.directory, s.path,
                  s.title, s.version, s.permission, s.time_created, s.time_updated, s.time_archived,
                  s.task_type, s.title_source, s.trace_id, s.last_outcome, s.time_deleted,
                  (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count
           FROM session s
           WHERE s.task_type = 'interactive' AND s.time_deleted IS NULL
           ORDER BY s.time_updated DESC`,
        )
        .all() as unknown as (SessionRow & { message_count: number })[];
      const modelStmt = db.prepare(
        "SELECT data FROM session_entry WHERE session_id=? AND type='runtime/model_selection' LIMIT 1",
      );
      const sessions: StoredSession[] = [];
      for (const row of rows) {
        let model: string | undefined;
        try {
          const entry = modelStmt.get(row.id) as { data: string } | undefined;
          const selection = asRecord(asRecord(JSON.parse(entry?.data ?? "{}"))?.modelSelection);
          model = firstString(selection?.modelId, selection?.providerId);
        } catch {
          model = undefined;
        }
        sessions.push({
          id: stableId("zcode", row.id),
          host: "zcode",
          nativeId: row.id,
          cwd: row.path ?? row.directory,
          title: row.title || titleFromText(undefined),
          model,
          createdAt: row.time_created,
          updatedAt: row.time_updated,
          rawRef: `${zcodeDbPath(this.paths)}#${row.id}`,
          fingerprint: `z:${row.time_updated}:${row.message_count}`,
          desktopVisible:
            visible.has(row.id) || visible.has(`sess_${row.id.replace(/^session_/, "")}`),
          counts: { turns: 0, parts: 0 },
        });
      }
      return sessions;
    } finally {
      db.close();
    }
  }

  async read(nativeId: string): Promise<SessionDetail> {
    const db = this.openDb();
    try {
      const row = db.prepare("SELECT * FROM session WHERE id=?").get(nativeId) as
        | SessionRow
        | undefined;
      if (!row) throw new Error(`ZCode session not found: ${nativeId}`);
      const messages = db
        .prepare(
          "SELECT id, sequence, time_created, time_updated, data FROM message WHERE session_id=? ORDER BY sequence, time_created",
        )
        .all(nativeId) as unknown as MessageRow[];
      const partStmt = db.prepare(
        "SELECT id, message_id, sequence, data FROM part WHERE message_id=? ORDER BY sequence, rowid",
      );
      const entryStmt = db.prepare(
        "SELECT data FROM session_entry WHERE session_id=? AND type='runtime/model_selection' LIMIT 1",
      );

      let model: string | undefined;
      try {
        const entry = entryStmt.get(nativeId) as { data: string } | undefined;
        const selection = asRecord(asRecord(JSON.parse(entry?.data ?? "{}"))?.modelSelection);
        model = firstString(selection?.modelId, selection?.providerId);
      } catch {
        model = undefined;
      }

      const turns: StoredTurn[] = [];
      const parts: StoredPart[] = [];
      const warnings = new Set<string>();
      let current: StoredTurn | undefined;
      let ord = 0;
      let hiddenMessages = 0;

      const newTurn = (ts: number): StoredTurn => {
        const turn: StoredTurn = {
          id: `${stableId("zcode", nativeId)}:turn:${turns.length}`,
          sessionId: stableId("zcode", nativeId),
          ord: turns.length,
          startedAt: ts,
        };
        turns.push(turn);
        return turn;
      };
      const push = (
        kind: PartKind,
        role: StoredPart["role"],
        text: string | undefined,
        payload: unknown,
        extra: Partial<StoredPart> = {},
      ): void => {
        const turn = current ?? newTurn(row.time_created);
        parts.push({
          id: `${stableId("zcode", nativeId)}:part:${ord}`,
          sessionId: stableId("zcode", nativeId),
          turnId: turn.id,
          ord,
          kind,
          role,
          text,
          payload,
          hash: sha256(JSON.stringify(payload ?? text ?? "")),
          ...extra,
        });
        ord += 1;
      };

      for (const message of messages) {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(message.data) as Record<string, unknown>;
        } catch {
          warnings.add("one message payload was not JSON");
          continue;
        }
        const semantics = asRecord(data.semantics) ?? {};
        const origin = str(semantics.origin);
        const kind = str(semantics.kind);
        const visibility = str(semantics.uiVisibility);
        const role = str(data.role);
        const synthetic = data.synthetic === true;
        const isHuman =
          origin === "real_user" &&
          (kind === "user_prompt" || kind === undefined) &&
          visibility !== "hidden";
        const messageParts = partStmt.all(message.id) as unknown as PartRow[];

        if (isHuman && role !== "assistant") {
          current = newTurn(num(asRecord(data.time)?.created) ?? message.time_created);
          for (const part of messageParts) pushLoadedPart(part, "user", push);
          if (current) current.endedAt = message.time_updated;
          continue;
        }
        if (synthetic || visibility === "hidden" || visibility === "model_only") {
          hiddenMessages += 1;
          continue;
        }
        if (role === "user" && (origin === "agent_runtime" || origin === "system")) {
          hiddenMessages += 1;
          continue;
        }
        if (role === "assistant" || role === "system") {
          for (const part of messageParts) {
            pushLoadedPart(part, role === "system" ? "system" : "assistant", push);
          }
          if (current) current.endedAt = message.time_updated;
          continue;
        }
        hiddenMessages += 1;
      }

      // Attach tool outputs to calls; ZCode already stores both in one part.
      for (const turn of turns) {
        const own = parts.filter((part) => part.turnId === turn.id);
        turn.outcome = own.some((part) => part.toolState === "error")
          ? "failed"
          : own.some((part) => part.kind === "tool_call")
            ? "tool-calls"
            : "completed";
        turn.endedAt ??= turn.startedAt;
      }

      const session: StoredSession = {
        id: stableId("zcode", nativeId),
        host: "zcode",
        nativeId,
        cwd: row.path ?? row.directory,
        title: row.title,
        model,
        createdAt: row.time_created,
        updatedAt: row.time_updated,
        rawRef: `${zcodeDbPath(this.paths)}#${nativeId}`,
        fingerprint: `z:${row.time_updated}:${messages.length}`,
        desktopVisible: true,
        counts: { turns: turns.length, parts: parts.length },
      };
      if (hiddenMessages) warnings.add(`${hiddenMessages} hidden/system messages omitted`);
      return { session, turns, parts, warnings: [...warnings] };
    } finally {
      db.close();
    }
  }

  async deepFingerprint(nativeId: string): Promise<string | undefined> {
    if (!existsSync(zcodeDbPath(this.paths))) return undefined;
    const db = this.openDb();
    try {
      const row = db.prepare("SELECT time_updated FROM session WHERE id=?").get(nativeId) as
        | { time_updated: number }
        | undefined;
      if (!row) return undefined;
      const counts = db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM message WHERE session_id=?) AS m,
                  (SELECT COUNT(*) FROM part WHERE session_id=?) AS p,
                  (SELECT COALESCE(MAX(time_updated),0) FROM message WHERE session_id=?) AS t`,
        )
        .get(nativeId, nativeId, nativeId) as { m: number; p: number; t: number };
      return sha256(`z|${row.time_updated}|${counts.m}|${counts.p}|${counts.t}`);
    } finally {
      db.close();
    }
  }

  async isBusy(): Promise<boolean> {
    const path = zcodeDbPath(this.paths);
    const { statSync } = await import("node:fs");
    for (const candidate of [path, `${path}-wal`]) {
      try {
        const info = statSync(candidate);
        if (Date.now() - info.mtimeMs < 15_000) return true;
      } catch {
        // Missing WAL means no recent writes.
      }
    }
    return false;
  }
}

function pushLoadedPart(
  part: PartRow,
  role: StoredPart["role"],
  push: (
    kind: PartKind,
    role: StoredPart["role"],
    text: string | undefined,
    payload: unknown,
    extra?: Partial<StoredPart>,
  ) => void,
): void {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(part.data) as Record<string, unknown>;
  } catch {
    push("system", role, truncate(part.data, 2000), part.data);
    return;
  }
  const type = str(data.type);
  const nativePartId = part.id;
  switch (type) {
    case "text":
    case "reasoning": {
      const text = str(data.text);
      if (!text) return;
      push(type === "reasoning" ? "reasoning" : "text", role, text, data, { nativePartId });
      return;
    }
    case "tool": {
      const state = asRecord(data.state) ?? {};
      const status = str(state.status);
      const tool = str(data.tool);
      push("tool_call", role, tool, data, {
        nativePartId,
        toolName: tool,
        toolCallId: str(data.callID),
        toolState:
          status === "error"
            ? "error"
            : status === "completed"
              ? "ok"
              : status
                ? "running"
                : "pending",
      });
      return;
    }
    case "file":
      push("file", role, firstString(data.filename, data.path), data, { nativePartId });
      return;
    case "compaction":
      push("system", "system", "Conversation compacted", data, { nativePartId });
      return;
    case "step-start":
    case "step-finish":
      push("step", role, undefined, data, { nativePartId });
      return;
    case "timeline":
      push("timeline", "system", firstString(data.display, data.timelineType), data, {
        nativePartId,
      });
      return;
    default:
      if (data.text) push("text", role, str(data.text), data, { nativePartId });
      else if (asArray(data.content).length) {
        push(
          "text",
          role,
          asArray(data.content)
            .map((item) => str(asRecord(item)?.text) ?? "")
            .join(""),
          data,
          {
            nativePartId,
          },
        );
      }
  }
}
