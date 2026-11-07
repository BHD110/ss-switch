import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "./sqlite";

import type { HostId } from "@bridge/contracts";

import { zcodeDbPath, zcodeTasksDbPath } from "@bridge/hosts";

import type { HostPaths } from "@bridge/hosts";

export interface VerificationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerificationResult {
  ok: boolean;
  checks: VerificationCheck[];
}

export function verifyQoder(
  paths: HostPaths,
  nativeId: string,
  expected: { messages: number; turns: number; file: string },
): VerificationResult {
  const checks: VerificationCheck[] = [];
  const dbOk = existsSync(paths.qoderDesktopDb);
  checks.push({
    name: "desktop-db",
    ok: dbOk,
    detail: paths.qoderDesktopDb,
  });
  if (dbOk) {
    const db = new DatabaseSync(paths.qoderDesktopDb, { readOnly: true });
    try {
      const session = db
        .prepare("SELECT session_id, title, message_envelope_version FROM chat_sessions WHERE session_id=?")
        .get(nativeId) as
        | { session_id: string; title: string; message_envelope_version: number }
        | undefined;
      checks.push({
        name: "session-row",
        ok: Boolean(session),
        detail: session ? `envelope v${session.message_envelope_version}` : "missing",
      });
      const messages = db
        .prepare("SELECT COUNT(*) AS c FROM chat_session_messages WHERE session_id=?")
        .get(nativeId) as { c: number };
      checks.push({
        name: "message-count",
        ok: messages.c === expected.messages,
        detail: `${messages.c}/${expected.messages}`,
      });
      const searchable = db
        .prepare("SELECT COUNT(*) AS c FROM chat_session_search_segments WHERE session_id=?")
        .get(nativeId) as { c: number };
      checks.push({
        name: "search-segments",
        ok: searchable.c > 0,
        detail: `${searchable.c} segments`,
      });
      const history = db
        .prepare("SELECT revision FROM chat_session_history_revisions WHERE session_id=?")
        .get(nativeId) as { revision: number } | undefined;
      checks.push({
        name: "history-revision",
        ok: Boolean(history),
        detail: history ? `revision ${history.revision}` : "missing",
      });
    } finally {
      db.close();
    }
  }
  const fileOk = existsSync(expected.file);
  let lines = 0;
  if (fileOk) {
    try {
      lines = readFileSync(expected.file, "utf8").split("\n").filter(Boolean).length;
    } catch {
      lines = 0;
    }
  }
  checks.push({ name: "jsonl", ok: fileOk && lines > 0, detail: `${lines} records` });
  return { ok: checks.every((check) => check.ok), checks };
}

export function verifyZcode(
  paths: HostPaths,
  nativeId: string,
  expected: { messages: number; parts: number },
): VerificationResult {
  const checks: VerificationCheck[] = [];
  const dbPath = zcodeDbPath(paths);
  if (!existsSync(dbPath)) {
    return { ok: false, checks: [{ name: "main-db", ok: false, detail: dbPath }] };
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const session = db
      .prepare("SELECT id, title FROM session WHERE id=? AND time_deleted IS NULL")
      .get(nativeId) as { id: string; title: string } | undefined;
    checks.push({ name: "session-row", ok: Boolean(session), detail: session?.title ?? "missing" });
    const messages = db
      .prepare("SELECT COUNT(*) AS c, MIN(sequence) AS lo, MAX(sequence) AS hi FROM message WHERE session_id=?")
      .get(nativeId) as { c: number; lo: number | null; hi: number | null };
    checks.push({
      name: "message-count",
      ok: messages.c === expected.messages,
      detail: `${messages.c}/${expected.messages} sequence ${messages.lo}..${messages.hi}`,
    });
    const contiguous =
      messages.c === 0 ||
      (messages.lo === 0 && messages.hi === messages.c - 1);
    checks.push({
      name: "message-sequence",
      ok: contiguous,
      detail: contiguous ? "contiguous" : "sequence has gaps",
    });
    const parts = db
      .prepare("SELECT COUNT(*) AS c FROM part WHERE session_id=?")
      .get(nativeId) as { c: number };
    checks.push({
      name: "part-count",
      ok: parts.c === expected.parts,
      detail: `${parts.c}/${expected.parts}`,
    });
    const selection = db
      .prepare(
        "SELECT COUNT(*) AS c FROM session_entry WHERE session_id=? AND type='runtime/model_selection'",
      )
      .get(nativeId) as { c: number };
    checks.push({
      name: "model-selection",
      ok: selection.c === 1,
      detail: `${selection.c} entries`,
    });
  } finally {
    db.close();
  }
  const indexPath = zcodeTasksDbPath(paths);
  if (existsSync(indexPath)) {
    const index = new DatabaseSync(indexPath, { readOnly: true });
    try {
      const task = index
        .prepare("SELECT task_id, project_id FROM tasks WHERE task_id=? AND deleted=0 LIMIT 1")
        .get(nativeId) as { task_id: string; project_id: string | null } | undefined;
      checks.push({
        name: "task-index",
        ok: Boolean(task),
        detail: task ? `project ${task.project_id}` : "missing task row",
      });
    } finally {
      index.close();
    }
  } else {
    checks.push({ name: "task-index", ok: false, detail: indexPath });
  }
  return { ok: checks.every((check) => check.ok), checks };
}

export function verifyHost(
  host: HostId,
  paths: HostPaths,
  nativeId: string,
  expected: { messages: number; parts?: number; turns?: number; file?: string },
): VerificationResult {
  if (host === "qoder") {
    return verifyQoder(paths, nativeId, {
      messages: expected.messages,
      turns: expected.turns ?? 0,
      file: expected.file ?? "",
    });
  }
  if (host === "zcode") {
    return verifyZcode(paths, nativeId, {
      messages: expected.messages,
      parts: expected.parts ?? 0,
    });
  }
  return { ok: false, checks: [{ name: "host", ok: false, detail: `${host} is read-only` }] };
}