/**
 * Shared contracts for Session Bridge.
 *
 * Everything the renderer may know crosses this file. The renderer never sees
 * filesystem paths it can open, native database handles, or SQL.
 */

export type HostId = "qoder" | "codex" | "zcode" | "workbuddy";

export const HOST_IDS: readonly HostId[] = ["qoder", "codex", "zcode", "workbuddy"];

export type Fidelity = "high" | "adapted" | "view_only";

export interface HostCapabilities {
  /** Session content can be read and previewed. */
  readable: boolean;
  /** A writer exists for this direction. */
  writable: boolean;
  /** Native desktop list can show a row written by Bridge (M0 verified). */
  desktopWritable: boolean;
  /** What cannot survive a round trip, shown in the switch panel. */
  losses: string[];
}

export interface HostStatus {
  id: HostId;
  displayName: string;
  installed: boolean;
  /** Desktop (or CLI) store exists and was readable. */
  detected: boolean;
  version?: string;
  root: string;
  sessionCount: number;
  /** False when a running process or unknown schema makes writes unsafe. */
  writeReady: boolean;
  writeBlockedReason?: string;
  capabilities: HostCapabilities;
  lastScanAt?: number;
}

export type PartKind =
  | "text"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "attachment"
  | "image"
  | "system"
  | "step"
  | "timeline"
  | "file";

export type PartRole = "user" | "assistant" | "system" | "tool";

export type ToolState = "pending" | "running" | "ok" | "error";

export interface StoredPart {
  id: string;
  sessionId: string;
  turnId: string;
  ord: number;
  nativePartId?: string;
  kind: PartKind;
  role: PartRole;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  toolState?: ToolState;
  /** Structured payload, already normalized by the host adapter. */
  payload: unknown;
  hash: string;
  sourceRef?: string;
  /** Set on a tool_result that was folded into the matching tool_call card. */
  mergedInto?: string;
}

export interface StoredTurn {
  id: string;
  sessionId: string;
  ord: number;
  outcome?: "completed" | "tool-calls" | "failed";
  startedAt: number;
  endedAt?: number;
}

export interface StoredSession {
  id: string;
  host: HostId;
  nativeId: string;
  cwd: string;
  title: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  rawRef: string;
  fingerprint: string;
  desktopVisible: boolean;
  counts: { turns: number; parts: number };
  /** Present when the session was imported by Bridge. */
  lineageId?: string;
  /** Tail hash captured at import time, used for divergence. */
  importedTailHash?: string;
}

export interface SessionDetail {
  session: StoredSession;
  turns: StoredTurn[];
  parts: StoredPart[];
  /** Warnings that affect fidelity, e.g. missing pages or unpaired tools. */
  warnings: string[];
}

export interface SessionRef {
  host: HostId;
  nativeId: string;
}

export type LineageMode = "copy" | "overwrite_same" | "overwrite_new";

export interface LineageRecord {
  id: string;
  srcSessionId: string;
  srcHost: HostId;
  dstSessionId: string;
  dstHost: HostId;
  mode: LineageMode;
  fidelity: Fidelity;
  srcFpAtImport: string;
  dstFpAtImport: string;
  createdAt: number;
}

export interface DivergenceInfo {
  lineageId: string;
  srcHost: HostId;
  dstHost: HostId;
  srcChanged: boolean;
  dstChanged: boolean;
  detectedAt: number;
}

export interface ImportPlanRequest {
  source: SessionRef;
  targetHost: HostId;
  /** Overwrite is only accepted when the target has not changed since import. */
  mode: "new_copy" | "overwrite";
  /** Target session to replace for overwrite mode. */
  targetNativeId?: string;
  title?: string;
  cwd?: string;
}

export interface ImportPlan {
  source: SessionRef;
  targetHost: HostId;
  mode: "new_copy" | "overwrite";
  fidelity: Fidelity;
  turns: number;
  parts: number;
  toolCalls: number;
  dropped: { kind: string; count: number; reason: string }[];
  warnings: string[];
  /** Empty when the plan can run; otherwise the user must change something. */
  blockers: string[];
  writeBlockedReason?: string;
  overwriteAllowed: boolean;
  overwriteReason?: string;
  backupNote: string;
}

export interface ImportResult {
  ok: boolean;
  targetHost: HostId;
  targetNativeId?: string;
  lineageId?: string;
  txId: string;
  fidelity: Fidelity;
  turns: number;
  parts: number;
  backupDir?: string;
  /** Command the user can run to open the target; never launched automatically. */
  openCommand?: string;
  warnings: string[];
  error?: string;
}

export interface TxSummary {
  id: string;
  kind: string;
  src?: string;
  dst?: string;
  state: "prepared" | "writing" | "verifying" | "committed" | "failed" | "rolled_back";
  startedAt: number;
  finishedAt?: number;
  error?: string;
  backupDir?: string;
}

export interface UndoResult {
  ok: boolean;
  txId: string;
  removedTargets: string[];
  error?: string;
}

export interface ScanReport {
  hosts: HostStatus[];
  scannedAt: number;
  warnings: string[];
}

export interface SessionQuery {
  host?: HostId;
  text?: string;
  limit?: number;
  includeCliOnly?: boolean;
}

export const IPC = {
  scan: "bridge:scan",
  hosts: "bridge:hosts",
  sessions: "bridge:sessions",
  sessionDetail: "bridge:session-detail",
  planImport: "bridge:plan-import",
  runImport: "bridge:run-import",
  history: "bridge:history",
  undo: "bridge:undo",
  openTarget: "bridge:open-target",
  openFolder: "bridge:open-folder",
  divergence: "bridge:divergence",
  appInfo: "bridge:app-info",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** The single object the preload script exposes as `window.bridge`. */
export interface BridgeApi {
  scan(force?: boolean): Promise<ScanReport>;
  hosts(): Promise<HostStatus[]>;
  sessions(query?: SessionQuery): Promise<StoredSession[]>;
  sessionDetail(ref: SessionRef): Promise<SessionDetail>;
  planImport(request: ImportPlanRequest): Promise<ImportPlan>;
  runImport(request: ImportPlanRequest): Promise<ImportResult>;
  history(): Promise<TxSummary[]>;
  undo(txId: string): Promise<UndoResult>;
  openTarget(result: ImportResult): Promise<{ ok: boolean; error?: string }>;
  openFolder(path: string): Promise<{ ok: boolean; error?: string }>;
  divergence(): Promise<DivergenceInfo[]>;
  appInfo(): Promise<{ version: string; userData: string; home: string }>;
}

/** Tools whose results are safe to re-render from stored text. */
export const KIND_LABELS: Record<PartKind, string> = {
  text: "Text",
  reasoning: "Thinking",
  tool_call: "Tool call",
  tool_result: "Tool result",
  attachment: "Attachment",
  image: "Image",
  system: "System",
  step: "Step",
  timeline: "Timeline",
  file: "File",
};