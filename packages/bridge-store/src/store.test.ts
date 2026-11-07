import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionDetail, StoredSession } from "@bridge/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { BridgeStore } from "./index";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function store(): BridgeStore {
  const root = mkdtempSync(join(tmpdir(), "ss-switch-store-"));
  roots.push(root);
  return new BridgeStore(join(root, "bridge.db"));
}

function session(nativeId: string, host: "qoder" = "qoder"): StoredSession {
  return {
    id: `${host}:${nativeId}`,
    host,
    nativeId,
    cwd: "C:/work",
    title: `title ${nativeId}`,
    createdAt: 1,
    updatedAt: 2,
    rawRef: "raw",
    fingerprint: "fp",
    desktopVisible: true,
    counts: { turns: 0, parts: 0 },
  };
}

function detail(sessionId: string): SessionDetail {
  return {
    session: {
      id: sessionId,
      host: "qoder",
      nativeId: sessionId.split(":")[1]!,
      cwd: "C:/work",
      title: "demo",
      createdAt: 1,
      updatedAt: 2,
      rawRef: "raw",
      fingerprint: "fp",
      desktopVisible: true,
      counts: { turns: 1, parts: 2 },
    },
    turns: [{ id: `${sessionId}:t1`, sessionId, ord: 0, startedAt: 1 }],
    parts: [
      {
        id: `${sessionId}:p1`,
        sessionId,
        turnId: `${sessionId}:t1`,
        ord: 0,
        kind: "tool_call",
        role: "assistant",
        toolName: "Read",
        toolCallId: "call1",
        payload: { input: {} },
        hash: "h1",
      },
      {
        id: `${sessionId}:p2`,
        sessionId,
        turnId: `${sessionId}:t1`,
        ord: 1,
        kind: "tool_result",
        role: "tool",
        toolCallId: "call1",
        text: "ok",
        payload: {},
        hash: "h2",
        mergedInto: `${sessionId}:p1`,
      },
    ],
    warnings: ["w"],
  };
}

describe("BridgeStore", () => {
  it("indexes sessions and preserves cached transcripts", () => {
    const db = store();
    db.replaceSessionIndex("qoder", [session("a"), session("b")], ["a", "b"]);
    expect(db.listSessions().map((item) => item.nativeId)).toEqual(["a", "b"]);
    db.saveDetail(detail("qoder:a"), ["cached warning"]);
    const cached = db.cachedDetail("qoder:a", "fp");
    expect(cached?.parts[1]?.mergedInto).toBe("qoder:a:p1");
    db.replaceSessionIndex("qoder", [session("a")], ["a"]);
    expect(db.listSessions().map((item) => item.nativeId)).toEqual(["a"]);
    db.close();
  });

  it("tracks lineage on both sides and deduplicates divergence", () => {
    const db = store();
    const id = db.addLineage({
      srcSessionId: "a",
      srcHost: "qoder",
      dstSessionId: "b",
      dstHost: "zcode",
      mode: "copy",
      fidelity: "adapted",
      srcFpAtImport: "src1",
      dstFpAtImport: "dst1",
      createdAt: 1,
    });
    expect(db.lineageTouching("qoder", "a")?.side).toBe("src");
    expect(db.lineageTouching("zcode", "b")?.side).toBe("dst");
    expect(db.hasDivergence(id, "src", "src2", "dst1")).toBe(false);
    db.recordDivergence(id, "src", "src2", "dst1");
    expect(db.hasDivergence(id, "src", "src2", "dst1")).toBe(true);
    expect(db.listDivergence()[0]?.srcChanged).toBe(true);
    db.close();
  });

  it("records transaction state transitions", () => {
    const db = store();
    db.createTx({ id: "tx1", kind: "import", src: "qoder:a", dst: "zcode:b" });
    expect(db.unfinishedTx()).toHaveLength(1);
    db.updateTx("tx1", "writing");
    db.updateTx("tx1", "committed");
    const tx = db.getTx("tx1");
    expect(tx?.state).toBe("committed");
    expect(tx?.finishedAt).toBeGreaterThan(0);
    expect(db.unfinishedTx()).toHaveLength(0);
    db.close();
  });
});
