import type {
  Fidelity,
  HostCapabilities,
  HostId,
  HostStatus,
  SessionDetail,
  StoredSession,
} from "@bridge/contracts";

export interface HostPaths {
  home: string;
  appData: string;
  qoderConfigDir: string;
  qoderDesktopDb: string;
  codexHome: string;
  zcodeHome: string;
  workbuddyHome: string;
}

export interface HostAdapter {
  readonly id: HostId;
  readonly displayName: string;
  readonly capabilities: HostCapabilities;
  /** Cheap probe: which store exists, what version, how many sessions. */
  status(sessions?: StoredSession[]): Promise<HostStatus>;
  /** Metadata for every session the host exposes. Never reads whole transcripts. */
  scan(): Promise<StoredSession[]>;
  /** Normalized transcript, read from the native store. */
  read(nativeId: string): Promise<SessionDetail>;
  /** Content hash used by lineage, not the cheap scan fingerprint. */
  deepFingerprint(nativeId: string): Promise<string | undefined>;
  /** True when a second process is using the store and writes must be refused. */
  isBusy(): Promise<boolean>;
}

export interface WriteOptions {
  /** New session id on the target; absent means copy/overwrite of the same id. */
  nativeId?: string;
  title?: string;
  cwd?: string;
  /** true only for explicit overwrite of an existing Bridge target. */
  overwrite?: boolean;
  /** Provenance stamped into the target so Bridge can recognise its own rows. */
  lineageId?: string;
  sourceHost?: string;
  sourceSessionId?: string;
  sourceModel?: string;
}

export interface WriteOutcome {
  nativeId: string;
  fidelity: Fidelity;
  turns: number;
  parts: number;
  /** Rows written to the host's message table, used by post-write verification. */
  nativeMessages: number;
  dropped: { kind: string; count: number; reason: string }[];
  warnings: string[];
  openCommand?: string;
  steps: { step: string; detail: string }[];
}

export interface HostWriter {
  readonly targetHost: HostId;
  /** Version gate; throws when the store is newer than this build knows. */
  assertSchema(): Promise<void>;
  /** True while the host process can still write the store. */
  isBusy(): Promise<boolean>;
  fingerprint(nativeId: string): Promise<string | undefined>;
  /** Insert a new session (never touches the source). */
  insert(detail: SessionDetail, options?: WriteOptions): Promise<WriteOutcome>;
  /** Replace a Bridge-created target in place after fingerprint verification. */
  overwrite(detail: SessionDetail, nativeId: string): Promise<WriteOutcome>;
  remove(nativeId: string): void;
  openCommand(nativeId: string): string;
}

export function emptyCapabilities(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    readable: true,
    writable: false,
    desktopWritable: false,
    losses: [],
    ...overrides,
  };
}

export const PART_ROLE = {
  user: "user",
  assistant: "assistant",
  system: "system",
  tool: "tool",
} as const;