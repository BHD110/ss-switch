import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostId, HostStatus, SessionDetail, StoredSession } from "@bridge/contracts";
import type { HostAdapter, HostPaths, HostWriter, WriteOptions, WriteOutcome } from "@bridge/hosts";
import { resolvePaths } from "@bridge/hosts";
import { BridgeStore } from "@bridge/store";
import { afterEach, describe, expect, it } from "vitest";

import { type ImportContext, planImport, runImport } from "./import";

const roots: string[] = [];
const stores: BridgeStore[] = [];
afterEach(() => {
  for (const db of stores.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

const detail: SessionDetail = {
  session: {
    id: "qoder:src",
    host: "qoder",
    nativeId: "src",
    cwd: "C:/work",
    title: "source",
    createdAt: 1,
    updatedAt: 2,
    rawRef: "raw",
    fingerprint: "fp",
    desktopVisible: true,
    counts: { turns: 2, parts: 4 },
  },
  turns: [
    { id: "t1", sessionId: "qoder:src", ord: 0, startedAt: 1 },
    { id: "t2", sessionId: "qoder:src", ord: 1, startedAt: 2 },
  ],
  parts: [
    {
      id: "p1",
      sessionId: "qoder:src",
      turnId: "t1",
      ord: 0,
      kind: "text",
      role: "user",
      text: "hi",
      payload: {},
      hash: "h1",
    },
    {
      id: "p2",
      sessionId: "qoder:src",
      turnId: "t1",
      ord: 1,
      kind: "tool_call",
      role: "assistant",
      toolName: "Read",
      toolCallId: "call1",
      payload: {},
      hash: "h2",
    },
    {
      id: "p3",
      sessionId: "qoder:src",
      turnId: "t1",
      ord: 2,
      kind: "system",
      role: "system",
      text: "compacted",
      payload: {},
      hash: "h3",
    },
    {
      id: "p4",
      sessionId: "qoder:src",
      turnId: "t2",
      ord: 3,
      kind: "text",
      role: "assistant",
      text: "done",
      payload: {},
      hash: "h4",
    },
  ],
  warnings: [],
};

class FakeAdapter implements HostAdapter {
  readonly displayName = "Fake";
  readonly capabilities = { readable: true, writable: false, desktopWritable: false, losses: [] };
  fp = "fp1";
  constructor(
    readonly id: HostId,
    private readonly sessions: StoredSession[] = [],
  ) {}
  async status(): Promise<HostStatus> {
    return {
      id: this.id,
      displayName: this.displayName,
      installed: true,
      detected: true,
      root: "/tmp",
      sessionCount: this.sessions.length,
      writeReady: false,
      capabilities: this.capabilities,
    };
  }
  async scan(): Promise<StoredSession[]> {
    return this.sessions;
  }
  async read(): Promise<SessionDetail> {
    return detail;
  }
  async deepFingerprint(): Promise<string> {
    return this.fp;
  }
  async isBusy(): Promise<boolean> {
    return false;
  }
}

class FakeWriter implements HostWriter {
  readonly targetHost = "zcode" as const;
  busy = false;
  fingerprintValue = "fp1";
  inserted?: { detail: SessionDetail; options?: WriteOptions };
  async assertSchema(): Promise<void> {}
  async isBusy(): Promise<boolean> {
    return this.busy;
  }
  async fingerprint(): Promise<string> {
    return this.fingerprintValue;
  }
  async insert(source: SessionDetail, options?: WriteOptions): Promise<WriteOutcome> {
    this.inserted = { detail: source, options };
    return {
      nativeId: options?.nativeId ?? "b",
      fidelity: "adapted",
      turns: 2,
      parts: 4,
      nativeMessages: 4,
      dropped: [],
      warnings: [],
      steps: [],
      openCommand: "open",
    };
  }
  async overwrite(): Promise<WriteOutcome> {
    return {
      nativeId: "b",
      fidelity: "adapted",
      turns: 2,
      parts: 4,
      nativeMessages: 4,
      dropped: [],
      warnings: [],
      steps: [],
    };
  }
  remove(): void {}
  openCommand(): string {
    return "open";
  }
}

function context(): { ctx: ImportContext; writer: FakeWriter; db: BridgeStore } {
  const root = mkdtempSync(join(tmpdir(), "ss-switch-migrate-"));
  roots.push(root);
  const paths: HostPaths = resolvePaths({ home: root, appData: root });
  const db = new BridgeStore(join(root, "bridge.db"));
  stores.push(db);
  const writer = new FakeWriter();
  const ctx: ImportContext = {
    paths,
    adapters: {
      qoder: new FakeAdapter("qoder"),
      codex: new FakeAdapter("codex"),
      zcode: new FakeAdapter("zcode"),
      workbuddy: new FakeAdapter("workbuddy"),
    },
    writers: { zcode: writer },
    store: db,
    backupRoot: join(root, "backups"),
  };
  return { ctx, writer, db };
}

describe("planImport", () => {
  it("counts parts, flags fidelity and dropped kinds", async () => {
    const { ctx } = context();
    const plan = await planImport(ctx, {
      source: { host: "qoder", nativeId: "src" },
      targetHost: "zcode",
      mode: "new_copy",
    });
    expect(plan.turns).toBe(2);
    expect(plan.parts).toBe(4);
    expect(plan.toolCalls).toBe(1);
    expect(plan.fidelity).toBe("adapted");
    expect(plan.dropped).toEqual([{ kind: "system", count: 1, reason: expect.any(String) }]);
    expect(plan.blockers).toEqual([]);
  });

  it("refuses same-host copies and running targets", async () => {
    const { ctx, writer } = context();
    const sameHost = await planImport(ctx, {
      source: { host: "zcode", nativeId: "src" },
      targetHost: "zcode",
      mode: "new_copy",
    });
    expect(sameHost.blockers.length).toBeGreaterThan(0);
    writer.busy = true;
    const busy = await planImport(ctx, {
      source: { host: "qoder", nativeId: "src" },
      targetHost: "zcode",
      mode: "new_copy",
    });
    expect(busy.blockers.join(" ")).toContain("running");
  });

  it("allows overwrite only when the target fingerprint is unchanged", async () => {
    const { ctx, db } = context();
    const request = {
      source: { host: "qoder", nativeId: "src" } as const,
      targetHost: "zcode" as const,
      mode: "overwrite" as const,
      targetNativeId: "b",
    };
    const denied = await planImport(ctx, request);
    expect(denied.overwriteAllowed).toBe(false);

    db.addLineage({
      srcSessionId: "src",
      srcHost: "qoder",
      dstSessionId: "b",
      dstHost: "zcode",
      mode: "copy",
      fidelity: "adapted",
      srcFpAtImport: "fp1",
      dstFpAtImport: "fp1",
      createdAt: 1,
    });
    const allowed = await planImport(ctx, request);
    expect(allowed.overwriteAllowed).toBe(true);

    (ctx.adapters.zcode as FakeAdapter).fp = "fp2";
    const changed = await planImport(ctx, request);
    expect(changed.overwriteAllowed).toBe(false);
    expect(changed.overwriteReason).toContain("changed");
  });

  it("can opt into writing a new copy into a running target", async () => {
    const { ctx, writer } = context();
    writer.busy = true;
    const plan = await planImport(ctx, {
      source: { host: "qoder", nativeId: "src" },
      targetHost: "zcode",
      mode: "new_copy",
      allowRunningWrite: true,
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.requiresRestart).toBe(true);
    expect(plan.warnings.join(" ")).toContain("正在运行");
  });

  it("never allows a running-target overwrite", async () => {
    const { ctx, writer } = context();
    writer.busy = true;
    const plan = await planImport(ctx, {
      source: { host: "qoder", nativeId: "src" },
      targetHost: "zcode",
      mode: "overwrite",
      targetNativeId: "b",
      allowRunningWrite: true,
    });
    expect(plan.blockers.join(" ")).toContain("running");
  });

  it("returns a failed result without writing when blocked", async () => {
    const { ctx, writer } = context();
    writer.busy = true;
    const result = await runImport(ctx, {
      source: { host: "qoder", nativeId: "src" },
      targetHost: "zcode",
      mode: "new_copy",
    });
    expect(result.ok).toBe(false);
    expect(writer.inserted).toBeUndefined();
    expect(result.error).toContain("running");
  });
});
