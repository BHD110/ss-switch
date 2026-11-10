import { type Dirent, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  HostStatus,
  SessionDetail,
  StoredPart,
  StoredSession,
  StoredTurn,
} from "@bridge/contracts";
import { workbuddyDbPath, workbuddyProjectsDir } from "../paths";
import { type Database, DatabaseSync } from "../sqlite";
import type { HostAdapter, HostPaths } from "../types";
import { emptyCapabilities } from "../types";
import {
  asArray,
  asRecord,
  cleanUserText,
  fileMeta,
  readJsonl,
  sha256,
  sha256File,
  stableId,
  str,
  titleFromText,
  toMs,
  truncate,
} from "../util";

interface WbSessionRow {
  id: string;
  cwd: string;
  title: string | null;
  custom_title: string | null;
  status: string | null;
  created_at: number | null;
  updated_at: number | null;
  deleted_at: number | null;
  model: string | null;
  last_activity_at: number | null;
}

export class WorkbuddyReader implements HostAdapter {
  readonly id = "workbuddy" as const;
  readonly displayName = "WorkBuddy";
  readonly capabilities = emptyCapabilities({
    writable: true,
    desktopWritable: true,
    losses: [
      "Tool results are stored inline as text, not in the tool-results folder",
      "Attachments are kept as references, not binaries",
    ],
  });

  constructor(readonly paths: HostPaths) {}

  async status(known?: StoredSession[]): Promise<HostStatus> {
    const installed = existsSync(this.paths.workbuddyHome);
    const sessions = known ?? (installed ? await this.scan() : []);
    return {
      id: this.id,
      displayName: this.displayName,
      installed,
      detected: installed,
      root: this.paths.workbuddyHome,
      sessionCount: sessions.length,
      writeReady: installed && existsSync(workbuddyDbPath(this.paths)),
      writeBlockedReason: installed ? undefined : "WorkBuddy data directory not found",
      capabilities: this.capabilities,
      lastScanAt: Date.now(),
    };
  }

  private rows(): Map<string, WbSessionRow> {
    const map = new Map<string, WbSessionRow>();
    const path = workbuddyDbPath(this.paths);
    if (!existsSync(path)) return map;
    let db: Database | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT id, cwd, title, custom_title, status, created_at, updated_at, deleted_at, model,
                  last_activity_at
           FROM sessions WHERE deleted_at IS NULL`,
        )
        .all() as unknown as WbSessionRow[];
      for (const row of rows) map.set(row.id, row);
    } catch {
      // Fall through to file-only listing.
    } finally {
      db?.close();
    }
    return map;
  }

  private async files(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    let projects: Dirent[];
    try {
      projects = await readdir(workbuddyProjectsDir(this.paths), { withFileTypes: true });
    } catch {
      return map;
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = join(workbuddyProjectsDir(this.paths), project.name);
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        map.set(entry.name.slice(0, -6), join(dir, entry.name));
      }
    }
    return map;
  }

  async scan(): Promise<StoredSession[]> {
    const rows = this.rows();
    const files = await this.files();
    const ids = new Set([...rows.keys(), ...files.keys()]);
    const sessions: StoredSession[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      const file = files.get(id);
      const meta = file ? await fileMeta(file) : { mtimeMs: 0, size: 0 };
      let header: { cwd?: string; title?: string; firstUserText?: string } = {};
      if (file) header = await this.header(file);
      sessions.push({
        id: stableId("workbuddy", id),
        host: "workbuddy",
        nativeId: id,
        cwd: row?.cwd ?? header.cwd ?? "",
        title:
          row?.custom_title ?? row?.title ?? header.title ?? titleFromText(header.firstUserText),
        model: row?.model ?? undefined,
        createdAt: row?.created_at ?? meta.mtimeMs,
        updatedAt: row?.last_activity_at ?? row?.updated_at ?? meta.mtimeMs,
        rawRef: file ?? `${workbuddyDbPath(this.paths)}#${id}`,
        fingerprint: `m:${meta.mtimeMs}:${meta.size}`,
        desktopVisible: Boolean(row),
        counts: { turns: 0, parts: 0 },
      });
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async header(
    path: string,
  ): Promise<{ cwd?: string; title?: string; firstUserText?: string }> {
    let cwd: string | undefined;
    let title: string | undefined;
    let firstUserText: string | undefined;
    let seen = 0;
    for await (const record of readJsonl(path)) {
      seen += 1;
      if (typeof record.cwd === "string") cwd ??= record.cwd;
      if (record.type === "ai-title") title = str(record.aiTitle) ?? title;
      if (record.type === "message" && record.role === "user" && !firstUserText) {
        firstUserText = wbText(record.content, "user");
      }
      if (seen >= 60) break;
    }
    return { cwd, title, firstUserText };
  }

  async read(nativeId: string): Promise<SessionDetail> {
    const session = (await this.scan()).find((item) => item.nativeId === nativeId);
    if (!session) throw new Error(`WorkBuddy session not found: ${nativeId}`);
    if (!session.rawRef.endsWith(".jsonl")) {
      throw new Error("WorkBuddy session has no transcript file");
    }
    const turns: StoredTurn[] = [];
    const parts: StoredPart[] = [];
    const warnings = new Set<string>();
    let current: StoredTurn | undefined;
    let ord = 0;

    const newTurn = (ts: number): StoredTurn => {
      const turn: StoredTurn = {
        id: `${session.id}:turn:${turns.length}`,
        sessionId: session.id,
        ord: turns.length,
        startedAt: ts,
      };
      turns.push(turn);
      return turn;
    };
    const push = (
      kind: StoredPart["kind"],
      role: StoredPart["role"],
      text: string | undefined,
      payload: unknown,
      extra: Partial<StoredPart> = {},
    ): void => {
      const turn = current ?? newTurn(session.createdAt);
      parts.push({
        id: `${session.id}:part:${ord}`,
        sessionId: session.id,
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

    for await (const record of readJsonl(session.rawRef)) {
      const ts = toMs(record.timestamp);
      const type = record.type;
      if (type === "message") {
        const role = str(record.role);
        const text = wbText(record.content, role ?? undefined);
        if (role === "user") {
          current = newTurn(ts);
          if (text) push("text", "user", text, record);
          for (const raw of asArray(record.content)) {
            const block = asRecord(raw);
            if (block?.type === "image_blob_ref") push("image", "user", undefined, block);
          }
        } else if (role === "assistant") {
          if (text) push("text", "assistant", text, record);
        }
        continue;
      }
      if (type === "reasoning") {
        const text = asArray(record.rawContent)
          .map((raw) => str(asRecord(raw)?.text) ?? "")
          .join("\n")
          .trim();
        if (text) push("reasoning", "assistant", text, record);
        continue;
      }
      if (type === "function_call") {
        const output = asRecord(record.output);
        push(
          "tool_call",
          "assistant",
          str(record.name),
          { ...record, input: toolInput(record) },
          {
            toolName: str(record.name),
            toolCallId: str(record.callId),
            toolState: output ? "ok" : "running",
            nativePartId: str(record.id),
          },
        );
        continue;
      }
      if (type === "function_call_result") {
        const output = record.output;
        const text =
          typeof output === "string"
            ? output
            : (str(asRecord(output)?.text) ?? JSON.stringify(output));
        push("tool_result", "tool", truncate(text ?? "", 400_000), record, {
          toolName: str(record.name),
          toolCallId: str(record.callId),
          toolState: record.status === "error" ? "error" : "ok",
          nativePartId: str(record.id),
        });
        continue;
      }
      if (type === "ai-title" && current) {
        session.title = str(record.aiTitle) ?? session.title;
      }
    }

    const results = new Map(
      parts
        .filter((part) => part.kind === "tool_result" && part.toolCallId)
        .map((part) => [part.toolCallId!, part]),
    );
    for (const part of parts) {
      if (part.kind !== "tool_call" || !part.toolCallId) continue;
      const result = results.get(part.toolCallId);
      if (result) {
        part.toolState = result.toolState === "error" ? "error" : "ok";
        (part.payload as Record<string, unknown>).result = result.text;
        result.mergedInto = part.id;
      }
    }
    for (const turn of turns) {
      const own = parts.filter((part) => part.turnId === turn.id);
      turn.outcome = own.some((part) => part.kind === "tool_call") ? "tool-calls" : "completed";
      turn.endedAt ??= turn.startedAt;
    }
    if (!turns.length) warnings.add("No user/assistant messages in this session");
    session.counts = { turns: turns.length, parts: parts.length };
    return { session, turns, parts, warnings: [...warnings] };
  }

  async deepFingerprint(nativeId: string): Promise<string | undefined> {
    const session = (await this.scan()).find((item) => item.nativeId === nativeId);
    if (!session?.rawRef.endsWith(".jsonl")) return undefined;
    return sha256File(session.rawRef);
  }

  async isBusy(): Promise<boolean> {
    return false;
  }
}

const HARNESS_MARKERS = [
  "<system-reminder",
  "<user_info>",
  "<identity_context>",
  "<environment_context",
  "<permissions instructions>",
];

/** WorkBuddy stores tool arguments as a JSON string. */
function toolInput(record: Record<string, unknown>): unknown {
  const raw = record.arguments;
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return { input: raw };
  }
}

function wbText(content: unknown, role?: string): string | undefined {
  const blocks = asArray(content);
  const text = blocks
    .map((raw) => {
      const block = asRecord(raw);
      if (!block) return "";
      if (block.type === "image_blob_ref") return "";
      return str(block.text) ?? "";
    })
    .filter((value) => {
      if (!value.trim()) return false;
      // User blocks carry the real prompt inside an envelope; cleanUserText
      // peels it below. Only assistant/system blocks are dropped outright.
      if (role === "user") return true;
      const head = value.trim().slice(0, 80).toLowerCase();
      return !HARNESS_MARKERS.some((marker) => head.startsWith(marker));
    })
    .join(String.fromCharCode(10));
  if (role === "user") return cleanUserText(text);
  return text.trim() || undefined;
}
