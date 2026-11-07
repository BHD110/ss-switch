import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeStore } from "../packages/bridge-store/src/index";
import {
  CodexReader,
  QoderReader,
  QoderWriter,
  resolvePaths,
  WorkbuddyReader,
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
  const writers = { qoder: new QoderWriter(paths), zcode: new ZcodeWriter(paths) };
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

  const lineage = store.lineageTouching("zcode", copyResult.targetNativeId!);
  check(
    "lineage.copy",
    lineage?.side === "dst" && Boolean(lineage.lineage.dstFpAtImport),
    "dst fingerprint stored",
  );

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
