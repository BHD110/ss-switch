import { createHash } from "node:crypto";

import type { SessionDetail, StoredPart, StoredTurn } from "../packages/contracts/src/index";

export interface FixtureOptions {
  cwd: string;
  title?: string;
  turns?: number;
  /** Include a tool call and a thinking block so adaptation is exercised. */
  rich?: boolean;
}

export function fixtureDetail(options: FixtureOptions): SessionDetail {
  const now = Date.now();
  const turns: StoredTurn[] = [];
  const parts: StoredPart[] = [];
  const count = options.turns ?? 2;
  const sessionId = "bridge:probe";
  for (let index = 0; index < count; index += 1) {
    const turnId = `${sessionId}:turn:${index}`;
    const startedAt = now + index * 30_000;
    turns.push({ id: turnId, sessionId, ord: index, startedAt, endedAt: startedAt + 20_000 });
    const add = (
      kind: StoredPart["kind"],
      role: StoredPart["role"],
      text: string | undefined,
      extra: Partial<StoredPart> = {},
    ): void => {
      parts.push({
        id: `${sessionId}:part:${parts.length}`,
        sessionId,
        turnId,
        ord: parts.length,
        kind,
        role,
        text,
        payload: {},
        hash: createHash("sha256").update(`${kind}-${index}-${parts.length}`).digest("hex"),
        ...extra,
      });
    };
    add("text", "user", `ss switch 可见性测试：第 ${index + 1} 条消息。`);
    if (options.rich !== false) {
      add("reasoning", "assistant", "先确认目标数据库，再写入一条测试会话。");
      add("tool_call", "assistant", "Bash", {
        toolName: "Bash",
        toolCallId: `call_probe_${index}`,
        toolState: "ok",
        payload: { input: { command: "echo ss-switch" }, result: "ss-switch" },
      });
    }
    add("text", "assistant", `已收到第 ${index + 1} 条消息。`);
  }
  return {
    session: {
      id: sessionId,
      host: "qoder",
      nativeId: "probe",
      cwd: options.cwd,
      title: options.title ?? "ss switch 可见性测试",
      createdAt: now,
      updatedAt: now,
      rawRef: "",
      fingerprint: "probe",
      desktopVisible: true,
      counts: { turns: turns.length, parts: parts.length },
    },
    turns,
    parts,
    warnings: [],
  };
}
