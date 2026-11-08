import { existsSync } from "node:fs";
import { join } from "node:path";

import { resolvePaths } from "../packages/hosts/src/index";
import { DatabaseSync } from "../packages/hosts/src/sqlite";

function projectSlug(cwd: string): string {
  return cwd
    .toLowerCase()
    .split(String.fromCharCode(92))
    .join("/")
    .split("/")
    .map((segment) => segment.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("-");
}

function main(): void {
  const paths = resolvePaths();
  const dbPath = join(paths.zcodeHome, "cli", "db", "db.sqlite");
  const index = join(paths.zcodeHome, "v2", "tasks-index.sqlite");
  if (!existsSync(dbPath) || !existsSync(index)) throw new Error("ZCode stores not found");

  const db = new DatabaseSync(dbPath);
  const tasks = new DatabaseSync(index);
  db.exec("PRAGMA busy_timeout=4000");
  tasks.exec("PRAGMA busy_timeout=4000");
  const rows = tasks
    .prepare(
      "SELECT task_id, workspace_key, model, provider, handoff_pending FROM tasks WHERE meta_json LIKE '%bridgeImported%'",
    )
    .all() as unknown as {
    task_id: string;
    workspace_key: string;
    model: string;
    provider: string | null;
    handoff_pending: number;
  }[];
  const report: unknown[] = [];
  for (const row of rows) {
    const session = db
      .prepare("SELECT directory, project_id FROM session WHERE id=?")
      .get(row.task_id) as { directory: string; project_id: string } | undefined;
    if (!session) continue;
    const expected = `proj_${projectSlug(session.directory)}`;
    const providerRow = tasks
      .prepare(
        "SELECT provider FROM tasks WHERE model=? AND provider IS NOT NULL AND provider <> 'account' LIMIT 1",
      )
      .get(row.model) as { provider: string } | undefined;
    const provider = providerRow?.provider ?? "glm";
    db.prepare("UPDATE session SET project_id=? WHERE id=?").run(expected, row.task_id);
    tasks
      .prepare(
        `UPDATE tasks SET provider=?, sort_order=NULL, title_overridden=0, cli_title_source='generated',
                          handoff_pending=handoff_pending | 8 WHERE workspace_key=? AND task_id=?`,
      )
      .run(provider, row.workspace_key, row.task_id);
    tasks
      .prepare(
        `INSERT INTO task_group_admissions(workspace_key, task_id, system_kind, user_organized, creation_id)
         VALUES(?,?,NULL,1,NULL)
         ON CONFLICT(workspace_key, task_id) DO UPDATE SET user_organized=1`,
      )
      .run(row.workspace_key, row.task_id);
    const assistantRows = db
      .prepare(
        "SELECT id, data FROM message WHERE session_id=? AND json_extract(data,'$.role')='assistant'",
      )
      .all(row.task_id) as unknown as { id: string; data: string }[];
    for (const message of assistantRows) {
      try {
        const data = JSON.parse(message.data) as Record<string, unknown>;
        data.tokens ??= { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
        data.cost ??= 0;
        db.prepare("UPDATE message SET data=? WHERE id=?").run(JSON.stringify(data), message.id);
      } catch {
        // Leave malformed payloads as-is.
      }
    }
    // meta_json is validated against a schema: provider must be one of
    // claude/opencode/gemini/codex/glm. "account" makes the whole row invalid.
    const metaRow = tasks
      .prepare("SELECT meta_json FROM tasks WHERE workspace_key=? AND task_id=?")
      .get(row.workspace_key, row.task_id) as { meta_json: string } | undefined;
    if (metaRow) {
      try {
        const meta = JSON.parse(metaRow.meta_json) as Record<string, unknown>;
        meta.provider = provider;
        tasks
          .prepare("UPDATE tasks SET meta_json=? WHERE workspace_key=? AND task_id=?")
          .run(JSON.stringify(meta), row.workspace_key, row.task_id);
      } catch {
        // Leave malformed metadata untouched; the row is reported below.
      }
    }
    const orderKey = JSON.stringify([row.workspace_key, row.task_id]);
    const maxOrder = (
      tasks
        .prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM task_group_view_node_orders")
        .get() as {
        m: number;
      }
    ).m;
    const next = Math.max(maxOrder + 1, 1);
    tasks
      .prepare(
        `INSERT OR IGNORE INTO task_group_view_node_orders(node_type, node_key, sort_order, created_at, updated_at)
         VALUES('task', ?, ?, ?, ?)`,
      )
      .run(orderKey, next, Date.now(), Date.now());
    tasks
      .prepare(
        `UPDATE task_group_view_node_orders SET sort_order=? WHERE node_type='task' AND node_key=? AND sort_order < 0`,
      )
      .run(next, orderKey);
    // Tool parts require read/write snapshots that an import cannot provide;
    // keep the call as readable text so ZCode can resume the conversation.
    const toolParts = db
      .prepare(
        "SELECT id, data FROM part WHERE session_id=? AND json_extract(data,'$.type')='tool'",
      )
      .all(row.task_id) as unknown as { id: string; data: string }[];
    for (const part of toolParts) {
      try {
        const data = JSON.parse(part.data) as {
          tool?: string;
          state?: { input?: unknown; output?: unknown; time?: { start?: number; end?: number } };
        };
        const name = data.tool ?? "tool";
        const input = JSON.stringify(data.state?.input ?? {}, null, 2);
        const output = data.state?.output;
        const clip = (value: string, max: number): string =>
          value.length > max
            ? `${value.slice(0, max)}
…（已截断，共 ${value.length} 字）`
            : value;
        const text = [
          `工具调用：${name}`,
          "输入：",
          clip(input, 3000),
          ...(output === undefined ? [] : ["", "输出：", clip(String(output), 6000)]),
        ].join(String.fromCharCode(10));
        const replacement = {
          type: "text",
          text,
          time: data.state?.time ?? { start: Date.now(), end: Date.now() },
          metadata: { bridgeTool: name },
        };
        db.prepare("UPDATE part SET data=? WHERE id=?").run(JSON.stringify(replacement), part.id);
      } catch {
        // Leave unexpected payloads as-is.
      }
    }
    report.push({
      task: row.task_id,
      oldProject: session.project_id,
      newProject: expected,
      oldProvider: row.provider,
      newProvider: provider,
      order: next,
      toolsAsText: toolParts.length,
    });
  }
  db.close();
  tasks.close();
  console.log(JSON.stringify(report, null, 2));
}

main();
