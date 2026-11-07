import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolvePaths } from "../paths";
import { DatabaseSync } from "../sqlite";
import { ZcodeReader } from "./read";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeDb(home: string): void {
  const dir = join(home, "cli", "db");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "db.sqlite"));
  db.exec(`
    CREATE TABLE session(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL,
      version TEXT NOT NULL, permission TEXT, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, time_archived INTEGER, task_type TEXT NOT NULL,
      title_source TEXT NOT NULL, trace_id TEXT, last_outcome TEXT, time_deleted INTEGER
    );
    CREATE TABLE message(
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL, sequence INTEGER
    );
    CREATE TABLE part(
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL,
      sequence INTEGER
    );
    CREATE TABLE session_entry(
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO session(id, project_id, workspace_id, parent_id, slug, directory, path, title,
                         version, permission, time_created, time_updated, time_archived, task_type,
                         title_source, trace_id, last_outcome, time_deleted)
     VALUES('s1','proj_x',NULL,NULL,'s1','C:/work','C:/work','演示会话','0.17.0','{"mode":"default"}',
            1000,2000,NULL,'interactive','custom','trace', 'completed', NULL)`,
  ).run();
  db.prepare(
    "INSERT INTO session_entry(id, session_id, type, time_created, time_updated, data) VALUES(?,?,?,?,?,?)",
  ).run(
    "e1",
    "s1",
    "runtime/model_selection",
    1000,
    1000,
    JSON.stringify({
      modelSelection: { providerId: "account:demo", modelId: "GLM-Demo", options: {} },
    }),
  );
  db.prepare(
    "INSERT INTO message(id, session_id, time_created, time_updated, data, sequence) VALUES(?,?,?,?,?,?)",
  ).run(
    "m1",
    "s1",
    1000,
    1000,
    JSON.stringify({
      role: "user",
      time: { created: 1000 },
      agent: "zcode-agent",
      path: { cwd: "C:/work", root: "C:/work" },
      semantics: {
        origin: "real_user",
        kind: "user_prompt",
        uiVisibility: "visible",
        providerVisibility: "visible",
        transcriptVisibility: "visible",
      },
    }),
    0,
  );
  db.prepare(
    "INSERT INTO message(id, session_id, time_created, time_updated, data, sequence) VALUES(?,?,?,?,?,?)",
  ).run(
    "m2",
    "s1",
    1001,
    1001,
    JSON.stringify({
      role: "assistant",
      time: { created: 1001, completed: 1100 },
      agent: "zcode-agent",
      path: { cwd: "C:/work", root: "C:/work" },
      semantics: {
        origin: "agent_runtime",
        kind: "assistant_response",
        uiVisibility: "visible",
        providerVisibility: "visible",
        transcriptVisibility: "visible",
      },
    }),
    1,
  );
  db.prepare(
    "INSERT INTO message(id, session_id, time_created, time_updated, data, sequence) VALUES(?,?,?,?,?,?)",
  ).run(
    "m3",
    "s1",
    1002,
    1002,
    JSON.stringify({
      role: "user",
      time: { created: 1002 },
      semantics: { origin: "agent_runtime", kind: "system_reminder", uiVisibility: "hidden" },
      synthetic: true,
    }),
    2,
  );
  const part = db.prepare(
    "INSERT INTO part(id, message_id, session_id, time_created, time_updated, data, sequence) VALUES(?,?,?,?,?,?,?)",
  );
  part.run("p1", "m1", "s1", 1000, 1000, JSON.stringify({ type: "text", text: "你好 ZCode" }), 0);
  part.run(
    "p2",
    "m2",
    "s1",
    1001,
    1100,
    JSON.stringify({
      type: "tool",
      callID: "call1",
      tool: "Read",
      state: { status: "completed", input: { path: "a" }, output: "内容", time: {} },
    }),
    0,
  );
  part.run("p3", "m2", "s1", 1001, 1100, JSON.stringify({ type: "text", text: "读完了" }), 1);
  part.run("p4", "m3", "s1", 1002, 1002, JSON.stringify({ type: "text", text: "hidden" }), 0);
  db.close();
}

describe("ZCode reader", () => {
  it("drops hidden system messages and maps tool parts", async () => {
    const root = mkdtempSync(join(tmpdir(), "ss-switch-zcode-"));
    roots.push(root);
    const home = join(root, ".zcode");
    makeDb(home);
    const reader = new ZcodeReader(resolvePaths({ home: root, zcodeHome: home }));
    const sessions = await reader.scan();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.title).toBe("演示会话");
    const detail = await reader.read("s1");
    expect(detail.turns).toHaveLength(1);
    expect(detail.parts.map((part) => part.kind)).toEqual(["text", "tool_call", "text"]);
    expect(detail.parts[0]?.text).toBe("你好 ZCode");
    expect(detail.parts[1]?.toolName).toBe("Read");
    expect(detail.parts[1]?.toolState).toBe("ok");
    expect(detail.parts.some((part) => part.text === "hidden")).toBe(false);
    expect(detail.session.model).toBe("GLM-Demo");
  });
});
