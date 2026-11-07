import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  DivergenceInfo,
  Fidelity,
  HostId,
  HostStatus,
  ImportPlan,
  LineageMode,
  LineageRecord,
  PartKind,
  PartRole,
  SessionDetail,
  SessionQuery,
  StoredPart,
  StoredSession,
  StoredTurn,
  TxSummary,
} from "@bridge/contracts";
import { type Database, DatabaseSync } from "./sqlite";

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS host (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  data_root TEXT NOT NULL,
  detected_version TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  last_scan_at INTEGER
);
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  native_id TEXT NOT NULL,
  cwd TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  model TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  raw_ref TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL DEFAULT '',
  desktop_visible INTEGER NOT NULL DEFAULT 1,
  meta_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(host, native_id)
);
CREATE INDEX IF NOT EXISTS session_host_updated ON session(host, updated_at DESC);
CREATE TABLE IF NOT EXISTS turn (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  outcome TEXT,
  started_at INTEGER NOT NULL DEFAULT 0,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS turn_session ON turn(session_id, ord);
CREATE TABLE IF NOT EXISTS part (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  native_part_id TEXT,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT,
  tool_name TEXT,
  tool_call_id TEXT,
  tool_state TEXT,
  payload_json TEXT NOT NULL DEFAULT 'null',
  hash TEXT NOT NULL,
  source_ref TEXT,
  merged_into TEXT
);
CREATE INDEX IF NOT EXISTS part_session ON part(session_id, ord);
CREATE INDEX IF NOT EXISTS part_tool_call ON part(session_id, tool_call_id);
CREATE TABLE IF NOT EXISTS lineage (
  id TEXT PRIMARY KEY,
  src_session_id TEXT NOT NULL,
  src_host TEXT NOT NULL,
  dst_session_id TEXT NOT NULL,
  dst_host TEXT NOT NULL,
  mode TEXT NOT NULL,
  fidelity TEXT NOT NULL,
  src_fp_at_import TEXT NOT NULL,
  dst_fp_at_import TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lineage_src ON lineage(src_host, src_session_id);
CREATE INDEX IF NOT EXISTS lineage_dst ON lineage(dst_host, dst_session_id);
CREATE TABLE IF NOT EXISTS tx (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  src TEXT,
  dst TEXT,
  state TEXT NOT NULL,
  backup_dir TEXT,
  steps_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS divergence (
  id TEXT PRIMARY KEY,
  lineage_id TEXT NOT NULL,
  side TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  src_tail_hash TEXT NOT NULL,
  dst_tail_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface CachedDetail {
  fingerprint: string;
  detail: SessionDetail;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class BridgeStore {
  readonly db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA busy_timeout=4000");
    this.db.exec(SCHEMA);
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version < 2) {
      const columns = new Set(
        (this.db.prepare("PRAGMA table_info(part)").all() as unknown as { name: string }[]).map(
          (column) => column.name,
        ),
      );
      if (!columns.has("merged_into")) {
        this.db.exec("ALTER TABLE part ADD COLUMN merged_into TEXT");
      }
    }
    if (row.user_version < SCHEMA_VERSION) {
      this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    }
    this.tryFts();
  }

  close(): void {
    this.db.close();
  }

  private tryFts(): void {
    try {
      this.db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS part_fts USING fts5(text, content='part', content_rowid='rowid', tokenize='trigram')",
      );
    } catch {
      // FTS5/trigram is optional; search falls back to LIKE.
    }
  }

  // ---------------------------------------------------------------- hosts

  upsertHost(status: HostStatus): void {
    this.db
      .prepare(
        `INSERT INTO host(id, display_name, data_root, detected_version, capabilities_json, last_scan_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           display_name=excluded.display_name,
           data_root=excluded.data_root,
           detected_version=excluded.detected_version,
           capabilities_json=excluded.capabilities_json,
           last_scan_at=excluded.last_scan_at`,
      )
      .run(
        status.id,
        status.displayName,
        status.root,
        status.version ?? null,
        JSON.stringify(status.capabilities),
        status.lastScanAt ?? Date.now(),
      );
  }

  listHosts(): HostStatus[] {
    const rows = this.db.prepare("SELECT * FROM host ORDER BY id").all() as unknown as HostRow[];
    return rows.map(hostFromRow);
  }

  // ------------------------------------------------------------- sessions

  /** Replace the metadata index for one host; content stays cached separately. */
  replaceSessionIndex(
    host: HostId,
    sessions: StoredSession[],
    seenNativeIds: string[],
  ): { removed: number } {
    const insert = this.db.prepare(
      `INSERT INTO session(id, host, native_id, cwd, title, model, created_at, updated_at,
                           raw_ref, fingerprint, desktop_visible, meta_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(host, native_id) DO UPDATE SET
         cwd=excluded.cwd, title=excluded.title, model=excluded.model,
         created_at=excluded.created_at, updated_at=excluded.updated_at,
         raw_ref=excluded.raw_ref, fingerprint=excluded.fingerprint,
         desktop_visible=excluded.desktop_visible, meta_json=excluded.meta_json`,
    );
    const keep = new Set(seenNativeIds);
    let removed = 0;
    this.transaction(() => {
      const existing = this.db
        .prepare("SELECT id, native_id FROM session WHERE host=?")
        .all(host) as { id: string; native_id: string }[];
      for (const row of existing) {
        if (keep.has(row.native_id)) continue;
        // Only drop rows that were never imported by Bridge; lineage targets
        // must survive even when a host hides them from its own list.
        const used = this.db
          .prepare(
            "SELECT 1 FROM lineage WHERE (src_host=? AND src_session_id=?) OR (dst_host=? AND dst_session_id=?)",
          )
          .get(host, row.id, host, row.id);
        if (used) continue;
        this.db.prepare("DELETE FROM session WHERE id=?").run(row.id);
        this.db.prepare("DELETE FROM turn WHERE session_id=?").run(row.id);
        this.db.prepare("DELETE FROM part WHERE session_id=?").run(row.id);
        removed += 1;
      }
      for (const session of sessions) {
        insert.run(
          session.id,
          session.host,
          session.nativeId,
          session.cwd,
          session.title,
          session.model ?? null,
          session.createdAt,
          session.updatedAt,
          session.rawRef,
          session.fingerprint,
          session.desktopVisible ? 1 : 0,
          JSON.stringify({
            lineageId: session.lineageId ?? null,
            importedTailHash: session.importedTailHash ?? null,
          }),
        );
      }
    });
    return { removed };
  }

  listSessions(query: SessionQuery = {}): StoredSession[] {
    const limit = Math.max(1, Math.min(query.limit ?? 500, 5000));
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.host) {
      where.push("host = ?");
      params.push(query.host);
    }
    if (query.includeCliOnly === false) where.push("desktop_visible = 1");
    if (query.text?.trim()) {
      where.push("(title LIKE ? OR cwd LIKE ?)");
      const like = `%${query.text.trim()}%`;
      params.push(like, like);
    }
    const sql = `SELECT * FROM session ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY updated_at DESC LIMIT ${limit}`;
    const rows = this.db.prepare(sql).all(...params) as unknown as SessionRow[];
    return rows.map(sessionFromRow);
  }

  getSession(host: HostId, nativeId: string): StoredSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM session WHERE host=? AND native_id=?")
      .get(host, nativeId) as SessionRow | undefined;
    return row ? sessionFromRow(row) : undefined;
  }

  getSessionById(id: string): StoredSession | undefined {
    const row = this.db.prepare("SELECT * FROM session WHERE id=?").get(id) as
      | SessionRow
      | undefined;
    return row ? sessionFromRow(row) : undefined;
  }

  /** Drop cached transcripts after a parser change; ids and lineage stay. */
  clearDetailCache(): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM turn");
      this.db.exec("DELETE FROM part");
    });
  }

  cachedDetail(sessionId: string, fingerprint: string): SessionDetail | undefined {
    const turns = this.db
      .prepare("SELECT * FROM turn WHERE session_id=? ORDER BY ord")
      .all(sessionId) as unknown as TurnRow[];
    if (!turns.length) return undefined;
    const session = this.db.prepare("SELECT * FROM session WHERE id=?").get(sessionId) as
      | SessionRow
      | undefined;
    if (!session || session.fingerprint !== fingerprint) return undefined;
    const parts = this.db
      .prepare("SELECT * FROM part WHERE session_id=? ORDER BY ord")
      .all(sessionId) as unknown as PartRow[];
    return {
      session: sessionFromRow(session),
      turns: turns.map(turnFromRow),
      parts: parts.map(partFromRow),
      warnings: [],
    };
  }

  /** Persist a normalized transcript so reopened sessions render without re-reading. */
  saveDetail(detail: SessionDetail, warnings: string[] = []): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM turn WHERE session_id=?").run(detail.session.id);
      this.db.prepare("DELETE FROM part WHERE session_id=?").run(detail.session.id);
      const turnStmt = this.db.prepare(
        "INSERT INTO turn(id, session_id, ord, outcome, started_at, ended_at) VALUES(?,?,?,?,?,?)",
      );
      for (const turn of detail.turns) {
        turnStmt.run(
          turn.id,
          detail.session.id,
          turn.ord,
          turn.outcome ?? null,
          turn.startedAt,
          turn.endedAt ?? null,
        );
      }
      const partStmt = this.db.prepare(
        `INSERT INTO part(id, session_id, turn_id, ord, native_part_id, kind, role, text,
                          tool_name, tool_call_id, tool_state, payload_json, hash, source_ref, merged_into)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const part of detail.parts) {
        partStmt.run(
          part.id,
          detail.session.id,
          part.turnId,
          part.ord,
          part.nativePartId ?? null,
          part.kind,
          part.role,
          part.text ?? null,
          part.toolName ?? null,
          part.toolCallId ?? null,
          part.toolState ?? null,
          JSON.stringify(part.payload ?? null),
          part.hash,
          part.sourceRef ?? null,
          part.mergedInto ?? null,
        );
      }
      this.db
        .prepare("UPDATE session SET meta_json=? WHERE id=?")
        .run(JSON.stringify({ warnings }), detail.session.id);
    });
  }

  cachedWarnings(sessionId: string): string[] {
    const row = this.db.prepare("SELECT meta_json FROM session WHERE id=?").get(sessionId) as
      | { meta_json: string }
      | undefined;
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.meta_json) as { warnings?: string[] };
      return parsed.warnings ?? [];
    } catch {
      return [];
    }
  }

  /** Full-transcript search for sessions whose parts are cached. */
  searchParts(text: string, limit = 30): string[] {
    const like = `%${text}%`;
    const rows = this.db
      .prepare(
        "SELECT DISTINCT session_id FROM part WHERE text LIKE ? AND kind IN ('text','reasoning','tool_result') LIMIT ?",
      )
      .all(like, limit) as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }

  // -------------------------------------------------------------- lineage

  addLineage(record: Omit<LineageRecord, "id"> & { id?: string }): string {
    const id = record.id ?? newId("lin");
    this.db
      .prepare(
        `INSERT INTO lineage(id, src_session_id, src_host, dst_session_id, dst_host, mode,
                             fidelity, src_fp_at_import, dst_fp_at_import, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        record.srcSessionId,
        record.srcHost,
        record.dstSessionId,
        record.dstHost,
        record.mode,
        record.fidelity,
        record.srcFpAtImport,
        record.dstFpAtImport,
        record.createdAt,
      );
    return id;
  }

  updateLineageSrcFingerprint(lineageId: string, fingerprint: string): void {
    this.db.prepare("UPDATE lineage SET src_fp_at_import=? WHERE id=?").run(fingerprint, lineageId);
  }

  updateLineageDstFingerprint(lineageId: string, fingerprint: string): void {
    this.db.prepare("UPDATE lineage SET dst_fp_at_import=? WHERE id=?").run(fingerprint, lineageId);
  }

  listLineage(): LineageRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM lineage ORDER BY created_at DESC")
        .all() as unknown as LineageRow[]
    ).map(lineageFromRow);
  }

  /** A lineage whose source or destination is this session. */
  lineageTouching(
    host: HostId,
    nativeId: string,
  ): { lineage: LineageRecord; side: "src" | "dst" } | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM lineage
         WHERE (dst_host=? AND dst_session_id=?) OR (src_host=? AND src_session_id=?)
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(host, nativeId, host, nativeId) as unknown as LineageRow | undefined;
    if (!row) return undefined;
    const lineage = lineageFromRow(row);
    return {
      lineage,
      side: lineage.dstHost === host && lineage.dstSessionId === nativeId ? "dst" : "src",
    };
  }

  lineageForTarget(host: HostId, nativeId: string): LineageRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM lineage WHERE dst_host=? AND dst_session_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(host, nativeId) as LineageRow | undefined;
    return row ? lineageFromRow(row) : undefined;
  }

  recordDivergence(
    lineageId: string,
    side: string,
    srcTailHash: string,
    dstTailHash: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO divergence(id, lineage_id, side, detected_at, src_tail_hash, dst_tail_hash)
         VALUES(?,?,?,?,?,?)`,
      )
      .run(newId("div"), lineageId, side, Date.now(), srcTailHash, dstTailHash);
  }

  /** True when the same divergence was already recorded, so scans stay quiet. */
  hasDivergence(lineageId: string, side: string, srcHash: string, dstHash: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM divergence WHERE lineage_id=? AND side=? AND src_tail_hash=? AND dst_tail_hash=?
         LIMIT 1`,
      )
      .get(lineageId, side, srcHash, dstHash);
    return Boolean(row);
  }

  listDivergence(): DivergenceInfo[] {
    return (
      this.db
        .prepare("SELECT * FROM divergence ORDER BY detected_at DESC LIMIT 500")
        .all() as unknown as DivergenceRow[]
    ).map((row) => {
      const r = row;
      const lineage = this.db.prepare("SELECT * FROM lineage WHERE id=?").get(r.lineage_id) as
        | LineageRow
        | undefined;
      return {
        lineageId: r.lineage_id,
        srcHost: (lineage?.src_host ?? "qoder") as HostId,
        dstHost: (lineage?.dst_host ?? "zcode") as HostId,
        srcChanged: r.side === "src",
        dstChanged: r.side === "dst",
        detectedAt: r.detected_at,
      };
    });
  }

  // ------------------------------------------------------------------- tx

  createTx(partial: {
    id: string;
    kind: string;
    src?: string;
    dst?: string;
    backupDir?: string;
    steps?: unknown[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO tx(id, kind, src, dst, state, backup_dir, steps_json, started_at)
         VALUES(?,?,?,?, 'prepared', ?, ?, ?)`,
      )
      .run(
        partial.id,
        partial.kind,
        partial.src ?? null,
        partial.dst ?? null,
        partial.backupDir ?? null,
        JSON.stringify(partial.steps ?? []),
        Date.now(),
      );
  }

  updateTx(
    id: string,
    state: TxSummary["state"],
    patch: { error?: string; steps?: unknown[]; backupDir?: string } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE tx SET state=?, error=COALESCE(?, error), steps_json=COALESCE(?, steps_json),
                       backup_dir=COALESCE(?, backup_dir),
                       finished_at=CASE WHEN ? IN ('committed','failed','rolled_back') THEN ? ELSE finished_at END
         WHERE id=?`,
      )
      .run(
        state,
        patch.error ?? null,
        patch.steps === undefined ? null : JSON.stringify(patch.steps),
        patch.backupDir ?? null,
        state,
        Date.now(),
        id,
      );
  }

  listTx(): TxSummary[] {
    return (
      this.db
        .prepare("SELECT * FROM tx ORDER BY started_at DESC LIMIT 200")
        .all() as unknown as TxRow[]
    ).map(txFromRow);
  }

  getTx(id: string): TxSummary | undefined {
    const row = this.db.prepare("SELECT * FROM tx WHERE id=?").get(id) as TxRow | undefined;
    return row ? txFromRow(row) : undefined;
  }

  unfinishedTx(): TxSummary[] {
    return (
      this.db
        .prepare("SELECT * FROM tx WHERE state IN ('prepared','writing','verifying')")
        .all() as unknown as TxRow[]
    ).map(txFromRow);
  }

  // -------------------------------------------------------------- settings

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The transaction may already have been rolled back by SQLite.
      }
      throw error;
    }
  }
}

// --------------------------------------------------------------- row types

interface HostRow {
  id: string;
  display_name: string;
  data_root: string;
  detected_version: string | null;
  capabilities_json: string;
  last_scan_at: number | null;
}

interface SessionRow {
  id: string;
  host: string;
  native_id: string;
  cwd: string;
  title: string;
  model: string | null;
  created_at: number;
  updated_at: number;
  raw_ref: string;
  fingerprint: string;
  desktop_visible: number;
  meta_json: string;
}

interface TurnRow {
  id: string;
  session_id: string;
  ord: number;
  outcome: string | null;
  started_at: number;
  ended_at: number | null;
}

interface PartRow {
  id: string;
  session_id: string;
  turn_id: string;
  ord: number;
  native_part_id: string | null;
  kind: string;
  role: string;
  text: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
  tool_state: string | null;
  payload_json: string;
  hash: string;
  source_ref: string | null;
  merged_into: string | null;
}

interface LineageRow {
  id: string;
  src_session_id: string;
  src_host: string;
  dst_session_id: string;
  dst_host: string;
  mode: string;
  fidelity: string;
  src_fp_at_import: string;
  dst_fp_at_import: string;
  created_at: number;
}

interface TxRow {
  id: string;
  kind: string;
  src: string | null;
  dst: string | null;
  state: string;
  backup_dir: string | null;
  steps_json: string;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

interface DivergenceRow {
  id: string;
  lineage_id: string;
  side: string;
  detected_at: number;
  src_tail_hash: string;
  dst_tail_hash: string;
}

// ------------------------------------------------------------------ mappers

function hostFromRow(row: HostRow): HostStatus {
  const capabilities = JSON.parse(row.capabilities_json || "{}");
  return {
    id: row.id as HostId,
    displayName: row.display_name,
    installed: true,
    detected: true,
    root: row.data_root,
    version: row.detected_version ?? undefined,
    sessionCount: 0,
    writeReady: false,
    capabilities,
  };
}

function sessionFromRow(row: SessionRow): StoredSession {
  let meta: { lineageId?: string | null; importedTailHash?: string | null } = {};
  try {
    meta = JSON.parse(row.meta_json || "{}");
  } catch {
    meta = {};
  }
  return {
    id: row.id,
    host: row.host as HostId,
    nativeId: row.native_id,
    cwd: row.cwd,
    title: row.title,
    model: row.model ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rawRef: row.raw_ref,
    fingerprint: row.fingerprint,
    desktopVisible: row.desktop_visible === 1,
    counts: { turns: 0, parts: 0 },
    lineageId: meta.lineageId ?? undefined,
    importedTailHash: meta.importedTailHash ?? undefined,
  };
}

function turnFromRow(row: TurnRow): StoredTurn {
  return {
    id: row.id,
    sessionId: row.session_id,
    ord: row.ord,
    outcome: (row.outcome ?? undefined) as StoredTurn["outcome"],
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
  };
}

function partFromRow(row: PartRow): StoredPart {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    ord: row.ord,
    nativePartId: row.native_part_id ?? undefined,
    kind: row.kind as PartKind,
    role: row.role as PartRole,
    text: row.text ?? undefined,
    toolName: row.tool_name ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    toolState: (row.tool_state ?? undefined) as StoredPart["toolState"],
    payload: JSON.parse(row.payload_json || "null"),
    hash: row.hash,
    sourceRef: row.source_ref ?? undefined,
    mergedInto: row.merged_into ?? undefined,
  };
}

function lineageFromRow(row: LineageRow): LineageRecord {
  return {
    id: row.id,
    srcSessionId: row.src_session_id,
    srcHost: row.src_host as HostId,
    dstSessionId: row.dst_session_id,
    dstHost: row.dst_host as HostId,
    mode: row.mode as LineageMode,
    fidelity: row.fidelity as Fidelity,
    srcFpAtImport: row.src_fp_at_import,
    dstFpAtImport: row.dst_fp_at_import,
    createdAt: row.created_at,
  };
}

function txFromRow(row: TxRow): TxSummary {
  return {
    id: row.id,
    kind: row.kind,
    src: row.src ?? undefined,
    dst: row.dst ?? undefined,
    state: row.state as TxSummary["state"],
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    error: row.error ?? undefined,
    backupDir: row.backup_dir ?? undefined,
  };
}

/** Imported planning helper, kept here so both UI and writers agree on labels. */
export function describePlan(plan: ImportPlan): string {
  const lines = [
    `${plan.source.host} → ${plan.targetHost}`,
    `mode: ${plan.mode}`,
    `fidelity: ${plan.fidelity}`,
    `turns: ${plan.turns}, parts: ${plan.parts}, tools: ${plan.toolCalls}`,
  ];
  for (const dropped of plan.dropped) {
    lines.push(`dropped ${dropped.count} ${dropped.kind}: ${dropped.reason}`);
  }
  return lines.join("\n");
}
