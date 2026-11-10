import { type Dirent, existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  HostStatus,
  SessionDetail,
  StoredPart,
  StoredSession,
  StoredTurn,
} from "@bridge/contracts";
import { codexDbPath, codexSessionsDir } from "../paths";
import { type Database, DatabaseSync } from "../sqlite";
import type { HostAdapter, HostPaths } from "../types";
import { emptyCapabilities } from "../types";
import {
  asArray,
  asRecord,
  cleanUserText,
  fileMeta,
  firstString,
  readJsonl,
  sha256,
  sha256File,
  stableId,
  str,
  titleFromText,
  toMs,
} from "../util";

interface SessionIndexEntry {
  id?: string;
  thread_name?: string;
  updated_at?: string;
}

export class CodexReader implements HostAdapter {
  readonly id = "codex" as const;
  readonly displayName = "Codex";
  readonly capabilities = emptyCapabilities({
    writable: true,
    desktopWritable: true,
    losses: [
      "Encrypted reasoning records stay encrypted on both sides",
      "Attachments are kept as references, not binaries",
    ],
  });

  private indexCache?: Map<string, SessionIndexEntry>;

  constructor(readonly paths: HostPaths) {}

  async status(known?: StoredSession[]): Promise<HostStatus> {
    const installed = existsSync(this.paths.codexHome);
    const sessions = known ?? (installed ? await this.scan() : []);
    let version: string | undefined;
    try {
      const text = await readFile(join(this.paths.codexHome, "version.json"), "utf8");
      version = (JSON.parse(text) as { version?: string }).version;
    } catch {
      version = undefined;
    }
    return {
      id: this.id,
      displayName: this.displayName,
      installed,
      detected: installed,
      root: this.paths.codexHome,
      version,
      sessionCount: sessions.length,
      writeReady: installed && existsSync(codexDbPath(this.paths)),
      writeBlockedReason: installed ? undefined : "Codex data directory not found",
      capabilities: this.capabilities,
      lastScanAt: Date.now(),
    };
  }

  private async index(): Promise<Map<string, SessionIndexEntry>> {
    if (this.indexCache) return this.indexCache;
    const map = new Map<string, SessionIndexEntry>();
    const path = join(this.paths.codexHome, "session_index.jsonl");
    if (existsSync(path)) {
      for await (const record of readJsonl(path)) {
        const id = str(record.id);
        if (id) map.set(id, record as SessionIndexEntry);
      }
    }
    this.indexCache = map;
    return map;
  }

  private async files(): Promise<string[]> {
    const result: string[] = [];
    const root = codexSessionsDir(this.paths);
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
        else if (entry.name.endsWith(".jsonl") && entry.name.startsWith("rollout-")) {
          result.push(full);
        }
      }
    };
    await walk(root);
    return result;
  }

  private threadVisible(nativeId: string): boolean {
    const db = codexDbPath(this.paths);
    if (!existsSync(db)) return true;
    let handle: Database | undefined;
    try {
      handle = new DatabaseSync(db, { readOnly: true });
      const row = handle
        .prepare("SELECT 1 FROM local_thread_catalog WHERE id=? LIMIT 1")
        .get(nativeId);
      return Boolean(row);
    } catch {
      return true;
    } finally {
      handle?.close();
    }
  }

  async scan(): Promise<StoredSession[]> {
    const index = await this.index();
    const files = await this.files();
    const sessions: StoredSession[] = [];
    // The same thread can have several rollout files (migrations/copies);
    // keep the newest one so the list and the store agree on a single row.
    const latest = new Map<string, (typeof sessions)[number]>();
    for (const path of files) {
      const meta = await fileMeta(path);
      const header = await this.header(path);
      if (!header) continue;
      const nativeId =
        header.id ??
        path
          .split(String.fromCharCode(92))
          .join("/")
          .split("/")
          .pop()!
          .replace(/\.jsonl$/, "");
      const entry = index.get(nativeId);
      const candidate: StoredSession = {
        id: stableId("codex", nativeId),
        host: "codex",
        nativeId,
        cwd: header.cwd ?? "",
        title: entry?.thread_name ?? titleFromText(header.firstUserText),
        model: header.model,
        createdAt: header.createdAt ?? meta.mtimeMs,
        updatedAt: entry?.updated_at ? toMs(entry.updated_at) : meta.mtimeMs,
        rawRef: path,
        fingerprint: `m:${meta.mtimeMs}:${meta.size}`,
        desktopVisible: this.threadVisible(nativeId),
        counts: { turns: 0, parts: 0 },
      };
      const previous = latest.get(nativeId);
      if (!previous || previous.updatedAt < candidate.updatedAt) latest.set(nativeId, candidate);
    }
    sessions.push(...latest.values());
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async header(
    path: string,
  ): Promise<
    | { id?: string; cwd?: string; model?: string; createdAt?: number; firstUserText?: string }
    | undefined
  > {
    let result: {
      id?: string;
      cwd?: string;
      model?: string;
      createdAt?: number;
      firstUserText?: string;
    } = {};
    let seen = 0;
    for await (const record of readJsonl(path)) {
      seen += 1;
      const payload = asRecord(record.payload);
      if (record.type === "session_meta" && payload) {
        result = {
          id: firstString(payload.id, payload.session_id),
          cwd: firstString(payload.cwd),
          createdAt: toMs(payload.timestamp),
        };
      } else if (record.type === "turn_context" && payload) {
        result.model = firstString(payload.model);
        result.cwd ??= firstString(payload.cwd);
      } else if (record.type === "event_msg" && payload?.type === "item_completed") {
        const item = asRecord(payload.item);
        if (item?.type === "UserMessage" && !result.firstUserText) {
          const text = blocksText(item.content);
          if (text && !looksLikeHarness(text)) result.firstUserText = text;
        }
      }
      // Headers are written near the top; 40 records is enough for metadata.
      if (seen >= 40) break;
    }
    return result.id || result.cwd ? result : undefined;
  }

  async read(nativeId: string): Promise<SessionDetail> {
    const session = (await this.scan()).find((item) => item.nativeId === nativeId);
    if (!session) throw new Error(`Codex session not found: ${nativeId}`);
    const turns: StoredTurn[] = [];
    const parts: StoredPart[] = [];
    const warnings = new Set<string>();
    const seenMessages = new Set<string>();
    let current: StoredTurn | undefined;
    let ord = 0;
    let sidechain = 0;
    let lastUserText: string | undefined;

    const newTurn = (startedAt: number): StoredTurn => {
      const turn: StoredTurn = {
        id: `${session.id}:turn:${turns.length}`,
        sessionId: session.id,
        ord: turns.length,
        startedAt,
      };
      turns.push(turn);
      return turn;
    };
    const ensureTurn = (ts: number): StoredTurn => {
      if (!current) current = newTurn(ts);
      return current;
    };
    const push = (
      kind: StoredPart["kind"],
      role: StoredPart["role"],
      text: string | undefined,
      payload: unknown,
      extra: Partial<StoredPart> = {},
    ): void => {
      const turn = ensureTurn(session.createdAt);
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
      const payload = asRecord(record.payload);
      if (!payload) continue;
      const ts = toMs(record.timestamp);
      if (record.type === "response_item") {
        const type = payload.type;
        if (type === "message") {
          const role = str(payload.role);
          if (role === "developer" || role === "system") continue;
          const text = blocksText(payload.content);
          if (!text) continue;
          const messageId = firstString(payload.id);
          if (messageId && seenMessages.has(messageId)) continue;
          if (messageId) seenMessages.add(messageId);
          if (role === "user") {
            if (looksLikeHarness(text)) continue;
            const cleaned = cleanUserText(text);
            if (!cleaned || cleaned === lastUserText) continue;
            lastUserText = cleaned;
            current = newTurn(ts);
            push("text", "user", cleaned, payload);
          } else if (role === "assistant") {
            push("text", "assistant", text, payload);
          }
          continue;
        }
        if (type === "reasoning") {
          const summary = asArray(payload.summary)
            .map((item) => str(asRecord(item)?.text) ?? "")
            .join("\n")
            .trim();
          if (summary) push("reasoning", "assistant", summary, payload);
          else sidechain += 1;
          continue;
        }
        if (type === "custom_tool_call" || type === "function_call") {
          push(
            "tool_call",
            "assistant",
            str(payload.name),
            { ...payload, input: toolInput(payload) },
            {
              toolName: str(payload.name),
              toolCallId: str(payload.call_id),
              toolState: payload.status === "completed" ? "ok" : "running",
              nativePartId: str(payload.id),
            },
          );
          continue;
        }
        if (type === "custom_tool_call_output" || type === "function_call_output") {
          const text =
            typeof payload.output === "string" ? payload.output : blocksText(payload.output);
          push("tool_result", "tool", text, payload, {
            toolCallId: str(payload.call_id),
            toolState: "ok",
          });
          continue;
        }
        if (type === "web_search_call") {
          push("tool_call", "assistant", "web_search", payload, {
            toolName: "web_search",
            toolCallId: str(payload.id),
            toolState: "ok",
          });
        }
        continue;
      }
      if (record.type === "event_msg") {
        const type = payload.type;
        if (type === "task_started") {
          current = newTurn(toMs(record.timestamp));
          continue;
        }
        if (type === "task_complete") {
          if (current) {
            current.outcome = "completed";
            current.endedAt = toMs(record.timestamp);
          }
          current = undefined;
          continue;
        }
        if (type === "turn_aborted") {
          if (current) {
            current.outcome = "failed";
            current.endedAt = toMs(record.timestamp);
          }
          current = undefined;
          continue;
        }
        if (type === "item_completed") {
          const item = asRecord(payload.item);
          if (item?.type === "UserMessage") {
            const text = blocksText(item.content);
            const id = firstString(item.id);
            const cleaned = text ? cleanUserText(text) : undefined;
            if (cleaned && cleaned !== lastUserText && (!id || !seenMessages.has(id))) {
              if (id) seenMessages.add(id);
              lastUserText = cleaned;
              current = newTurn(ts);
              push("text", "user", cleaned, item);
            }
          }
        }
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
        part.toolState = "ok";
        (part.payload as Record<string, unknown>).result = result.text;
        result.mergedInto = part.id;
      }
    }
    const kept = turns.filter((turn) => parts.some((part) => part.turnId === turn.id));
    kept.forEach((turn, index) => {
      turn.ord = index;
    });
    for (const turn of kept) {
      turn.outcome ??= parts.some((part) => part.turnId === turn.id && part.kind === "tool_call")
        ? "tool-calls"
        : "completed";
      turn.endedAt ??= turn.startedAt;
    }
    if (sidechain) warnings.add(`${sidechain} encrypted reasoning records were not decrypted`);
    session.counts = { turns: kept.length, parts: parts.length };
    return { session, turns: kept, parts, warnings: [...warnings] };
  }

  async deepFingerprint(nativeId: string): Promise<string | undefined> {
    const session = (await this.scan()).find((item) => item.nativeId === nativeId);
    if (!session) return undefined;
    return sha256File(session.rawRef);
  }

  async isBusy(): Promise<boolean> {
    return false;
  }
}

function looksLikeHarness(text: string): boolean {
  const head = text.trim().slice(0, 120).toLowerCase();
  return (
    head.startsWith("<environment_context") ||
    head.startsWith("<user_instructions") ||
    head.startsWith("<system-reminder") ||
    head.startsWith("# agents.md") ||
    head.startsWith("<permissions instructions") ||
    head.startsWith("<turn_context") ||
    head.startsWith("<instructions") ||
    head.startsWith("<external_")
  );
}

/** `function_call.arguments` is a JSON string; freeform custom tools are plain text. */
function toolInput(payload: Record<string, unknown>): unknown {
  if (Array.isArray(payload.input)) return payload.input;
  if (payload.input && typeof payload.input === "object") return payload.input;
  const raw = typeof payload.arguments === "string" ? payload.arguments : payload.input;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return { input: raw };
    }
  }
  return {};
}

function blocksText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  const text = asArray(content)
    .map((raw) => {
      const block = asRecord(raw);
      if (!block) return "";
      if (typeof block.text === "string") return block.text;
      if (typeof block.content === "string") return block.content;
      return "";
    })
    .join("\n")
    .trim();
  return text || undefined;
}
