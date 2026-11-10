import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeStore } from "../packages/bridge-store/src/index";
import {
  CodexReader,
  CodexWriter,
  QoderReader,
  QoderWriter,
  resolvePaths,
  WorkbuddyReader,
  WorkbuddyWriter,
  ZcodeReader,
  ZcodeWriter,
} from "../packages/hosts/src/index";
import { DatabaseSync } from "../packages/hosts/src/sqlite";
import {
  detectDivergence,
  type ImportContext,
  planImport,
  runImport,
  undoImport,
} from "../packages/migrate/src/index";
import { fixtureDetail } from "./fixture";

const results: { step: string; ok: boolean; detail: string }[] = [];
function check(step: string, ok: boolean, detail = ""): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`${step}: ${detail}`);
}

function copyDbSet(from: string, to: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${from}${suffix}`)) {
      mkdirSync(join(to, ".."), { recursive: true });
      copyFileSync(`${from}${suffix}`, `${to}${suffix}`);
    }
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ss-switch-e2e-"));
  const live = resolvePaths();
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });

  copyDbSet(live.qoderDesktopDb, join(root, "qoder", "main.sqlite"));
  copyDbSet(
    join(live.zcodeHome, "cli", "db", "db.sqlite"),
    join(root, "zcode", ".zcode", "cli", "db", "db.sqlite"),
  );
  copyDbSet(
    join(live.zcodeHome, "v2", "tasks-index.sqlite"),
    join(root, "zcode", ".zcode", "v2", "tasks-index.sqlite"),
  );
  copyDbSet(join(live.codexHome, "sqlite", "codex.db"), join(root, ".codex", "sqlite", "codex.db"));
  copyDbSet(join(live.workbuddyHome, "workbuddy.db"), join(root, ".workbuddy", "workbuddy.db"));
  mkdirSync(join(root, ".codex", "sessions"), { recursive: true });

  const paths = resolvePaths({
    home: root,
    appData: root,
    qoderConfigDir: join(root, "qoder", ".qoder-cn"),
    qoderDesktopDb: join(root, "qoder", "main.sqlite"),
    codexHome: join(root, ".codex"),
    zcodeHome: join(root, "zcode", ".zcode"),
    workbuddyHome: join(root, ".workbuddy"),
  });
  const adapters = {
    qoder: new QoderReader(paths),
    codex: new CodexReader(paths),
    zcode: new ZcodeReader(paths),
    workbuddy: new WorkbuddyReader(paths),
  };
  const writers = {
    qoder: new QoderWriter(paths),
    codex: new CodexWriter(paths),
    zcode: new ZcodeWriter(paths),
    workbuddy: new WorkbuddyWriter(paths),
  };
  const store = new BridgeStore(join(root, "bridge.db"));
  const ctx: ImportContext = { paths, adapters, writers, store, backupRoot: join(root, "backups") };

  const qoderId = "00000000-0000-4000-8000-0000000000aa";
  await writers.qoder.insert(fixtureDetail({ cwd: workspace, title: "端到端测试" }), {
    nativeId: qoderId,
    title: "端到端测试",
    cwd: workspace,
  });
  const sourceFp = await adapters.qoder.deepFingerprint(qoderId);
  check("setup.qoder-session", Boolean(sourceFp), qoderId);

  const copyPlan = await planImport(ctx, {
    source: { host: "qoder", nativeId: qoderId },
    targetHost: "zcode",
    mode: "new_copy",
  });
  check(
    "plan.copy",
    copyPlan.blockers.length === 0 && copyPlan.turns === 2,
    JSON.stringify(copyPlan.blockers),
  );

  const copyResult = await runImport(ctx, {
    source: { host: "qoder", nativeId: qoderId },
    targetHost: "zcode",
    mode: "new_copy",
    title: "端到端测试",
    cwd: workspace,
  });
  check(
    "run.copy",
    copyResult.ok && Boolean(copyResult.targetNativeId),
    copyResult.error ?? copyResult.targetNativeId ?? "",
  );
  const zcopy = await adapters.zcode.read(copyResult.targetNativeId!);
  check("run.copy.readback", zcopy.turns.length === 2, `${zcopy.turns.length} turns`);
  check(
    "run.copy.source-unchanged",
    (await adapters.qoder.deepFingerprint(qoderId)) === sourceFp,
    "deep hash equal",
  );

  // A write updates the WAL; that must not make the target look "running".
  check(
    "busy.after-write",
    !(await writers.zcode.isBusy()) && !(await writers.qoder.isBusy()),
    "both writers idle after their own write",
  );
  const replan = await planImport(ctx, {
    source: { host: "qoder", nativeId: qoderId },
    targetHost: "zcode",
    mode: "new_copy",
  });
  check("replan.no-running-blocker", replan.blockers.length === 0, JSON.stringify(replan.blockers));

  const slug = workspace
    .toLowerCase()
    .split(String.fromCharCode(92))
    .join("/")
    .split("/")
    .map((segment) => segment.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("-");
  const zdbCheck = new DatabaseSync(join(root, "zcode", ".zcode", "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  const importedProject = (
    zdbCheck
      .prepare("SELECT project_id FROM session WHERE id=?")
      .get(copyResult.targetNativeId!) as {
      project_id: string;
    }
  ).project_id;
  zdbCheck.close();
  check("zcode.project-id", importedProject === `proj_${slug}`, importedProject);

  const idxCheck = new DatabaseSync(join(root, "zcode", ".zcode", "v2", "tasks-index.sqlite"), {
    readOnly: true,
  });
  const taskRow = idxCheck
    .prepare("SELECT provider, handoff_pending FROM tasks WHERE task_id=?")
    .get(copyResult.targetNativeId!) as { provider: string; handoff_pending: number };
  const admission = idxCheck
    .prepare("SELECT user_organized FROM task_group_admissions WHERE task_id=?")
    .get(copyResult.targetNativeId!) as { user_organized: number } | undefined;
  const order = idxCheck
    .prepare(
      "SELECT sort_order FROM task_group_view_node_orders WHERE node_type='task' AND node_key=json_array(?,?)",
    )
    .get(workspace, copyResult.targetNativeId!) as { sort_order: number } | undefined;
  idxCheck.close();
  check("zcode.provider", taskRow.provider !== "account", taskRow.provider);
  check("zcode.user-organized", admission?.user_organized === 1, String(admission?.user_organized));
  check("zcode.order-positive", (order?.sort_order ?? 0) > 0, String(order?.sort_order));

  const zdbPayload = new DatabaseSync(join(root, "zcode", ".zcode", "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  const assistantRow = zdbPayload
    .prepare(
      "SELECT data FROM message WHERE session_id=? AND json_extract(data,'$.role')='assistant' LIMIT 1",
    )
    .get(copyResult.targetNativeId!) as { data: string } | undefined;
  const assistantData = assistantRow ? (JSON.parse(assistantRow.data) as { tokens?: unknown }) : {};
  const toolCount = (
    zdbPayload
      .prepare(
        "SELECT COUNT(*) AS c FROM part WHERE session_id=? AND json_extract(data,'$.type')='tool'",
      )
      .get(copyResult.targetNativeId!) as { c: number }
  ).c;
  zdbPayload.close();
  check(
    "zcode.assistant-tokens",
    Boolean(assistantData.tokens),
    JSON.stringify(assistantData.tokens),
  );
  check("zcode.tools-as-text", toolCount === 0, `${toolCount} tool parts`);

  const lineage = store.lineageTouching("zcode", copyResult.targetNativeId!);
  check(
    "lineage.copy",
    lineage?.side === "dst" && Boolean(lineage.lineage.dstFpAtImport),
    "dst fingerprint stored",
  );

  // A new copy into Qoder needs its JSONL path for post-write verification.
  const qoderNew = await runImport(ctx, {
    source: { host: "zcode", nativeId: copyResult.targetNativeId! },
    targetHost: "qoder",
    mode: "new_copy",
    title: "端到端测试",
    cwd: workspace,
  });
  check("run.qoder-new-copy", qoderNew.ok, qoderNew.error ?? qoderNew.targetNativeId ?? "");
  const qoderNewRead = await adapters.qoder.read(qoderNew.targetNativeId!);
  check("qoder.new-copy.readback", qoderNewRead.turns.length === 2, `${qoderNewRead.turns.length}`);
  check("undo.qoder-new-copy", (await undoImport(ctx, qoderNew.txId)).ok, "removed");

  const overwritePlan = await planImport(ctx, {
    source: { host: "zcode", nativeId: copyResult.targetNativeId! },
    targetHost: "qoder",
    mode: "overwrite",
    targetNativeId: qoderId,
  });
  check(
    "plan.overwrite-back",
    overwritePlan.overwriteAllowed,
    overwritePlan.overwriteReason ?? "original side unchanged",
  );

  const overwriteResult = await runImport(ctx, {
    source: { host: "zcode", nativeId: copyResult.targetNativeId! },
    targetHost: "qoder",
    mode: "overwrite",
    targetNativeId: qoderId,
    title: "端到端测试",
    cwd: workspace,
  });
  check("run.overwrite-back", overwriteResult.ok, overwriteResult.error ?? "");
  const restored = await adapters.qoder.read(qoderId);
  check("run.overwrite.readback", restored.turns.length === 2, `${restored.turns.length} turns`);

  const divergence = await detectDivergence(ctx);
  check("divergence.quiet", divergence.length === 0, `${divergence.length} entries`);

  const undoOverwrite = await undoImport(ctx, overwriteResult.txId);
  check("undo.overwrite", undoOverwrite.ok, undoOverwrite.error ?? "");
  const afterRestore = await adapters.qoder.read(qoderId);
  check(
    "undo.overwrite.readback",
    afterRestore.turns.length === 2,
    `${afterRestore.turns.length} turns`,
  );

  // A changed destination must be reported as a fork, not silently overwritten.
  const zdb = new DatabaseSync(join(root, "zcode", ".zcode", "cli", "db", "db.sqlite"));
  zdb
    .prepare("UPDATE session SET time_updated = time_updated + 5000 WHERE id=?")
    .run(copyResult.targetNativeId!);
  zdb.close();
  const fork = await detectDivergence(ctx);
  check(
    "divergence.detected",
    fork.some((item) => item.dstChanged && !item.srcChanged),
    JSON.stringify(fork),
  );

  // A newer private schema must fail closed, not guess at columns.
  const schemaDb = new DatabaseSync(join(root, "zcode", ".zcode", "cli", "db", "db.sqlite"));
  schemaDb
    .prepare(
      "INSERT INTO schema_migration(id, checksum, app_version, time_applied) VALUES(?,?,?,?)",
    )
    .run("0099_future", "x", "9.9.9", Date.now());
  schemaDb.close();
  let rejected = false;
  try {
    await writers.zcode.assertSchema();
  } catch {
    rejected = true;
  }
  check("schema.fail-closed", rejected, "0099 rejected");

  const undoCopy = await undoImport(ctx, copyResult.txId);
  check("undo.copy", undoCopy.ok, undoCopy.error ?? "");
  const zSessions = await adapters.zcode.scan();
  check(
    "undo.copy.removed",
    zSessions.every((session) => session.nativeId !== copyResult.targetNativeId),
    "target gone",
  );

  // ---------------------------------------------------------------- Codex
  const codexPlan = await planImport(ctx, {
    source: { host: "qoder", nativeId: qoderId },
    targetHost: "codex",
    mode: "new_copy",
  });
  check(
    "plan.codex",
    codexPlan.blockers.length === 0 && codexPlan.turns === 2,
    JSON.stringify(codexPlan.blockers),
  );
  const codexCopy = await runImport(ctx, {
    source: { host: "qoder", nativeId: qoderId },
    targetHost: "codex",
    mode: "new_copy",
    title: "端到端测试",
    cwd: workspace,
  });
  check(
    "run.codex",
    codexCopy.ok && Boolean(codexCopy.targetNativeId),
    codexCopy.error ?? codexCopy.targetNativeId ?? "",
  );
  const codexId = codexCopy.targetNativeId!;
  const codexReadback = await adapters.codex.read(codexId);
  check("codex.readback", codexReadback.turns.length === 2, `${codexReadback.turns.length} turns`);
  const codexSession = (await adapters.codex.scan()).find((item) => item.nativeId === codexId);
  check(
    "codex.rollout-file",
    Boolean(codexSession?.rawRef.endsWith(".jsonl")),
    codexSession?.rawRef ?? "missing",
  );
  const codexIndex = new DatabaseSync(join(root, ".codex", "sqlite", "codex.db"), {
    readOnly: true,
  });
  const codexCatalog = codexIndex
    .prepare("SELECT display_title FROM local_thread_catalog WHERE thread_id=?")
    .get(codexId) as { display_title: string } | undefined;
  codexIndex.close();
  check("codex.catalog-row", codexCatalog?.display_title === "端到端测试", "catalog row");
  const codexIndexLines = readFileSync(join(root, ".codex", "session_index.jsonl"), "utf8");
  check("codex.session-index", codexIndexLines.includes(codexId), "index entry");

  // ------------------------------------------------------------- WorkBuddy
  const wbPlan = await planImport(ctx, {
    source: { host: "qoder", nativeId: qoderId },
    targetHost: "workbuddy",
    mode: "new_copy",
  });
  check(
    "plan.workbuddy",
    wbPlan.blockers.length === 0 && wbPlan.turns === 2,
    JSON.stringify(wbPlan.blockers),
  );
  const wbCopy = await runImport(ctx, {
    source: { host: "qoder", nativeId: qoderId },
    targetHost: "workbuddy",
    mode: "new_copy",
    title: "端到端测试",
    cwd: workspace,
  });
  check(
    "run.workbuddy",
    wbCopy.ok && Boolean(wbCopy.targetNativeId),
    wbCopy.error ?? wbCopy.targetNativeId ?? "",
  );
  const wbId = wbCopy.targetNativeId!;
  const wbReadback = await adapters.workbuddy.read(wbId);
  check("workbuddy.readback", wbReadback.turns.length === 2, `${wbReadback.turns.length} turns`);
  const wbDb = new DatabaseSync(join(root, ".workbuddy", "workbuddy.db"), { readOnly: true });
  const wbRow = wbDb.prepare("SELECT title, session_settings FROM sessions WHERE id=?").get(wbId) as
    | { title: string; session_settings: string }
    | undefined;
  wbDb.close();
  check("workbuddy.session-row", wbRow?.title === "端到端测试", wbRow?.title ?? "missing");
  check(
    "workbuddy.bridge-marker",
    Boolean(wbRow && JSON.parse(wbRow.session_settings).bridgeVersion),
    "marker stored",
  );

  // Codex -> WorkBuddy proves the two new adapters transfer between each other.
  const cross = await runImport(ctx, {
    source: { host: "codex", nativeId: codexId },
    targetHost: "workbuddy",
    mode: "new_copy",
    title: "端到端测试",
    cwd: workspace,
  });
  check("run.codex-to-workbuddy", cross.ok, cross.error ?? cross.targetNativeId ?? "");
  const crossRead = await adapters.workbuddy.read(cross.targetNativeId!);
  check("cross.readback", crossRead.turns.length === 2, `${crossRead.turns.length} turns`);

  // Codex overwrite restores the previous rollout through its backup.
  const codexOverwritePlan = await planImport(ctx, {
    source: { host: "workbuddy", nativeId: wbId },
    targetHost: "codex",
    mode: "overwrite",
    targetNativeId: codexId,
  });
  check(
    "plan.codex-overwrite",
    codexOverwritePlan.overwriteAllowed,
    codexOverwritePlan.overwriteReason ?? "allowed",
  );
  const codexOverwrite = await runImport(ctx, {
    source: { host: "workbuddy", nativeId: wbId },
    targetHost: "codex",
    mode: "overwrite",
    targetNativeId: codexId,
    title: "端到端测试",
    cwd: workspace,
  });
  check("run.codex-overwrite", codexOverwrite.ok, codexOverwrite.error ?? "");
  const codexAfterOverwrite = await adapters.codex.read(codexId);
  check(
    "codex.overwrite.readback",
    codexAfterOverwrite.turns.length === 2,
    `${codexAfterOverwrite.turns.length} turns`,
  );
  check("undo.codex-overwrite", (await undoImport(ctx, codexOverwrite.txId)).ok, "restored");
  check(
    "codex.overwrite.restored",
    (await adapters.codex.read(codexId)).turns.length === 2,
    "backup restored",
  );

  check("undo.cross", (await undoImport(ctx, cross.txId)).ok, "cross removed");
  check("undo.workbuddy", (await undoImport(ctx, wbCopy.txId)).ok, "workbuddy removed");
  check("undo.codex", (await undoImport(ctx, codexCopy.txId)).ok, "codex removed");
  check(
    "undo.codex.removed",
    (await adapters.codex.scan()).every((item) => item.nativeId !== codexId),
    "catalog and rollout gone",
  );
  const wbAfter = new DatabaseSync(join(root, ".workbuddy", "workbuddy.db"), { readOnly: true });
  const wbGone = wbAfter.prepare("SELECT COUNT(*) AS c FROM sessions WHERE id=?").get(wbId) as {
    c: number;
  };
  wbAfter.close();
  check("undo.workbuddy.removed", wbGone.c === 0, "row gone");

  console.log(
    JSON.stringify({ passed: results.filter((item) => item.ok).length, failed: 0 }, null, 2),
  );
  store.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
