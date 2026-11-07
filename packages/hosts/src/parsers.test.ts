import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CodexReader } from "./codex/read";
import { resolvePaths } from "./paths";
import { QoderReader } from "./qoder/read";
import { WorkbuddyReader } from "./workbuddy/read";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ss-switch-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

const ISO = "2026-11-07T10:00:00.000Z";

describe("Qoder reader", () => {
  it("parses user, thinking, a paired tool call and assistant text", async () => {
    const root = tempRoot();
    const cwd = join(root, "work");
    const config = join(root, ".qoder-cn");
    const file = join(config, "projects", "slug", "11111111-1111-4111-8111-111111111111.jsonl");
    mkdirSync(join(config, "projects", "slug"), { recursive: true });
    writeFileSync(
      file,
      jsonl([
        { type: "workspace-directories", sessionId: "s1", directories: [cwd] },
        { type: "runtime-config", sessionId: "s1", model: "demo-model", timestamp: 1 },
        {
          type: "user",
          uuid: "u1",
          timestamp: ISO,
          message: { role: "user", content: [{ type: "text", text: "请读一下文件" }] },
          origin: { kind: "human" },
          humanInput: { text: "请读一下文件", mode: "prompt" },
          parentUuid: null,
          sessionId: "s1",
          cwd,
        },
        {
          type: "assistant",
          uuid: "a1",
          timestamp: ISO,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "先看看目录" },
              { type: "tool_use", id: "call1", name: "Read", input: { file_path: "x" } },
            ],
          },
          parentUuid: "u1",
          sessionId: "s1",
          cwd,
        },
        {
          type: "user",
          uuid: "t1",
          timestamp: ISO,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call1", content: "文件内容" }],
          },
          parentUuid: "a1",
          sessionId: "s1",
          cwd,
        },
        {
          type: "assistant",
          uuid: "a2",
          timestamp: ISO,
          message: { role: "assistant", content: [{ type: "text", text: "读完了" }] },
          parentUuid: "t1",
          sessionId: "s1",
          cwd,
        },
        { type: "last-prompt", sessionId: "s1", lastPrompt: "请读一下文件" },
        { type: "active-leaf", sessionId: "s1", leafUuid: "a2", explicit: true, timestamp: 2 },
      ]),
    );
    const reader = new QoderReader(resolvePaths({ home: root, qoderConfigDir: config }));
    const sessions = await reader.scan();
    expect(sessions).toHaveLength(1);
    const detail = await reader.read(sessions[0]!.nativeId);
    expect(detail.session.cwd).toBe(cwd);
    expect(detail.turns).toHaveLength(1);
    expect(detail.parts.map((part) => part.kind)).toEqual([
      "text",
      "reasoning",
      "tool_call",
      "tool_result",
      "text",
    ]);
    const call = detail.parts.find((part) => part.kind === "tool_call");
    expect(call?.toolName).toBe("Read");
    expect((call!.payload as Record<string, unknown>).result).toBe("文件内容");
    expect(detail.parts.some((part) => part.mergedInto === call?.id)).toBe(true);
  });
});

describe("Codex reader", () => {
  it("deduplicates the mirrored user prompt and filters harness context", async () => {
    const root = tempRoot();
    const cwd = join(root, "work");
    const file = join(root, ".codex", "sessions", "2026", "11", "07", "rollout-1.jsonl");
    mkdirSync(join(root, ".codex", "sessions", "2026", "11", "07"), { recursive: true });
    writeFileSync(
      file,
      jsonl([
        {
          timestamp: ISO,
          type: "session_meta",
          payload: { id: "c1", cwd, timestamp: ISO },
        },
        {
          timestamp: ISO,
          type: "response_item",
          payload: {
            type: "message",
            id: "harness1",
            role: "user",
            content: [{ type: "input_text", text: "# AGENTS.md instructions\nstuff" }],
          },
        },
        {
          timestamp: ISO,
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: {
              type: "UserMessage",
              id: "um1",
              content: [{ type: "text", text: "你好 Codex" }],
            },
          },
        },
        {
          timestamp: ISO,
          type: "response_item",
          payload: {
            type: "message",
            id: "rp1",
            role: "user",
            content: [{ type: "input_text", text: "你好 Codex" }],
          },
        },
        {
          timestamp: ISO,
          type: "response_item",
          payload: {
            type: "message",
            id: "as1",
            role: "assistant",
            content: [{ type: "output_text", text: "你好，需要什么？" }],
          },
        },
        {
          timestamp: ISO,
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            status: "completed",
            call_id: "call1",
            name: "exec",
            input: "ls",
          },
        },
        {
          timestamp: ISO,
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call1",
            output: [{ type: "input_text", text: "a.txt" }],
          },
        },
        { timestamp: ISO, type: "event_msg", payload: { type: "task_complete" } },
      ]),
    );
    const reader = new CodexReader(resolvePaths({ home: root, codexHome: join(root, ".codex") }));
    const sessions = await reader.scan();
    expect(sessions).toHaveLength(1);
    const detail = await reader.read("c1");
    expect(detail.turns).toHaveLength(1);
    expect(
      detail.parts.filter((part) => part.kind === "text" && part.role === "user"),
    ).toHaveLength(1);
    expect(detail.parts[0]!.text).toBe("你好 Codex");
    const call = detail.parts.find((part) => part.kind === "tool_call");
    expect((call!.payload as Record<string, unknown>).result).toBe("a.txt");
  });
});

describe("WorkBuddy reader", () => {
  it("extracts the user_query from the context envelope", async () => {
    const root = tempRoot();
    const home = join(root, ".workbuddy");
    const file = join(home, "projects", "p1", "a1.jsonl");
    mkdirSync(join(home, "projects", "p1"), { recursive: true });
    writeFileSync(
      file,
      jsonl([
        { type: "session-meta", sessionId: "a1", timestamp: 1, meta: {} },
        {
          type: "message",
          id: "m1",
          timestamp: 2,
          role: "user",
          content: [
            {
              type: "input_text",
              text: '<system-reminder data-role="user-context"><user_info>OS</user_info></system-reminder>\n<user_query>帮我看看记忆</user_query>',
            },
          ],
          sessionId: "a1",
          cwd: "C:/work",
        },
        {
          type: "reasoning",
          id: "r1",
          parentId: "m1",
          timestamp: 3,
          rawContent: [{ type: "reasoning_text", text: "先查记忆" }],
          content: [],
          providerData: {},
          sessionId: "a1",
          cwd: "C:/work",
        },
        {
          type: "function_call",
          id: "f1",
          parentId: "r1",
          timestamp: 4,
          callId: "call1",
          name: "ToolSearch",
          arguments: {},
          sessionId: "a1",
          cwd: "C:/work",
        },
        {
          type: "function_call_result",
          id: "f2",
          parentId: "f1",
          timestamp: 5,
          name: "ToolSearch",
          callId: "call1",
          status: "completed",
          output: { type: "text", text: "found" },
          sessionId: "a1",
          cwd: "C:/work",
        },
        {
          type: "ai-title",
          id: "t1",
          timestamp: 6,
          aiTitle: "记忆列表",
          sessionId: "a1",
          cwd: "C:/work",
        },
      ]),
    );
    const reader = new WorkbuddyReader(resolvePaths({ home: root, workbuddyHome: home }));
    const detail = await reader.read("a1");
    expect(detail.session.title).toBe("记忆列表");
    expect(detail.parts[0]?.kind).toBe("text");
    expect(detail.parts[0]?.text).toBe("帮我看看记忆");
    const call = detail.parts.find((part) => part.kind === "tool_call");
    expect((call!.payload as Record<string, unknown>).result).toBe("found");
  });
});
