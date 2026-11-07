import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionDetail, StoredPart } from "../packages/contracts/src/index";
import {
  QoderReader,
  QoderWriter,
  ZcodeReader,
  ZcodeWriter,
  resolvePaths,
} from "../packages/hosts/src/index";
import { verifyQoder, verifyZcode } from "../packages/verify/src/index";

const results: { step: string; ok: boolean; detail: string }[] = [];
function check(step: string, ok: boolean, detail = ""): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`${step}: ${detail}`);
}

async function main(): Promise<void> {
  const now = Date.now();
  const root = mkdtempSync(join(tmpdir(), "ss-switch-m0-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });

  function copyDbSet(from: string, to: string): void {
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${from}${suffix}`;
      if (existsSync(source)) {
        mkdirSync(join(to, ".."), { recursive: true });
        copyFileSync(source, `${to}${suffix}`);
      }
    }
  }

  const live = resolvePaths();

  // ---------------------------------------------------------------- Qoder copy
  const qoderRoot = join(root, "qoder");
  mkdirSync(join(qoderRoot, ".qoder-cn", "projects"), { recursive: true });
  copyDbSet(live.qoderDesktopDb, join(qoderRoot, "main.sqlite"));
  const qoderPaths = resolvePaths({
    home: root,
    appData: root,
    qoderConfigDir: join(qoderRoot, ".qoder-cn"),
    qoderDesktopDb: join(qoderRoot, "main.sqlite"),
  });
  const qoderWriter = new QoderWriter(qoderPaths);
  const qoderReader = new QoderReader(qoderPaths);

  function makeDetail(turns: number, prefix: string): SessionDetail {
    const parts: StoredPart[] = [];
    const turnList = [];
    for (let index = 0; index < turns; index += 1) {
      const turnId = `m0-turn-${index}`;
      const startedAt = now + index * 60_000;
      turnList.push({ id: turnId, sessionId: "m0", ord: index, startedAt, endedAt: startedAt + 30_000 });
      parts.push({
        id: `m0-part-user-${index}`,
        sessionId: "m0",
        turnId,
        ord: parts.length,
        kind: "text",
        role: "user",
        text: `${prefix} 第 ${index + 1} 条用户消息：请总结这个仓库。`,
        payload: {},
        hash: createHash("sha256").update(`user-${index}`).digest("hex"),
      });
      parts.push({
        id: `m0-part-think-${index}`,
        sessionId: "m0",
        turnId,
        ord: parts.length,
        kind: "reasoning",
        role: "assistant",
        text: `思考 ${index + 1}：先读目录，再调用工具。`,
        payload: {},
        hash: createHash("sha256").update(`think-${index}`).digest("hex"),
      });
      parts.push({
        id: `m0-part-call-${index}`,
        sessionId: "m0",
        turnId,
        ord: parts.length,
        kind: "tool_call",
        role: "assistant",
        text: "Bash",
        toolName: "Bash",
        toolCallId: `call_m0_${index}`,
        toolState: "ok",
        payload: {
          input: { command: "ls -la" },
          result: `file-${index}.txt\nREADME.md`,
        },
        hash: createHash("sha256").update(`call-${index}`).digest("hex"),
      });
      parts.push({
        id: `m0-part-answer-${index}`,
        sessionId: "m0",
        turnId,
        ord: parts.length,
        kind: "text",
        role: "assistant",
        text: `回答 ${index + 1}：仓库里有两个文件。`,
        payload: {},
        hash: createHash("sha256").update(`answer-${index}`).digest("hex"),
      });
    }
    return {
      session: {
        id: "qoder:m0",
        host: "qoder",
        nativeId: "m0",
        cwd: workspace,
        title: `${prefix} M0 测试会话`,
        model: "m0-model",
        createdAt: now,
        updatedAt: now,
        rawRef: "",
        fingerprint: "m0",
        desktopVisible: true,
        counts: { turns: turnList.length, parts: parts.length },
      },
      turns: turnList,
      parts,
      warnings: [],
    };
  }

  const qoderId = "00000000-0000-4000-8000-000000000001";
  const qoderOut = await qoderWriter.insert(makeDetail(2, "Qoder"), { nativeId: qoderId, title: "M0 Qoder 测试" });
  check("qoder.insert", qoderOut.nativeMessages === 4, `${qoderOut.nativeMessages} messages`);
  const qoderVerify = verifyQoder(qoderPaths, qoderId, {
    messages: qoderOut.nativeMessages,
    turns: qoderOut.turns,
    file: join(qoderRoot, ".qoder-cn", "projects", workspace.replace(/[^A-Za-z0-9]/g, "-"), `${qoderId}.jsonl`),
  });
  check("qoder.verify", qoderVerify.ok, JSON.stringify(qoderVerify.checks.filter((c) => !c.ok)));
  const qoderRead = await qoderReader.read(qoderId);
  check("qoder.readback", qoderRead.turns.length === 2 && qoderRead.parts.some((p) => p.kind === "tool_call"), `${qoderRead.turns.length} turns`);
  check(
    "qoder.readback.text",
    qoderRead.parts.some((p) => p.kind === "text" && (p.text ?? "").includes("请总结这个仓库")),
    "user text present",
  );

  const cli = join(live.home, ".qoder-cn", "bin", "qoderclicn", "qoderclicn.exe");
  if (existsSync(cli)) {
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (/^(QODER_AGENT_SDK|QODER_SDK|QODER_CONFIG_DIR|QODERCN_CONFIG_DIR|CLAUDECODE)/i.test(key)) {
        delete cleanEnv[key];
      }
    }
    const listed = spawnSync(cli, ["--config-dir", join(qoderRoot, ".qoder-cn"), "--list-sessions"], {
      encoding: "utf8",
      timeout: 60_000,
      cwd: workspace,
      env: cleanEnv,
    });
    const output = `${listed.stdout ?? ""}\n${listed.stderr ?? ""}`;
    check("qoder.cli-list", output.includes(qoderId), `exit ${listed.status} error=${listed.error?.message ?? "none"}: ${output.trim().slice(0, 200)}`);
  } else {
    check("qoder.cli-list", false, "qoderclicn.exe not found");
  }

  const overwritten = await qoderWriter.overwrite(makeDetail(3, "Qoder 覆盖"), qoderId);
  const qoderReRead = await qoderReader.read(qoderId);
  check("qoder.overwrite", qoderReRead.turns.length === 3 && overwritten.nativeMessages === 6, `${qoderReRead.turns.length} turns`);
  qoderWriter.remove(qoderId);
  const qoderFile = join(
    qoderRoot,
    ".qoder-cn",
    "projects",
    workspace.replace(/[^A-Za-z0-9]/g, "-"),
    `${qoderId}.jsonl`,
  );
  check("qoder.remove", !existsSync(qoderFile), `jsonl removed: ${qoderFile}`);

  // --------------------------------------------------------------- ZCode copy
  const zcodeRoot = join(root, "zcode");
  copyDbSet(join(live.zcodeHome, "cli", "db", "db.sqlite"), join(zcodeRoot, ".zcode", "cli", "db", "db.sqlite"));
  copyDbSet(join(live.zcodeHome, "v2", "tasks-index.sqlite"), join(zcodeRoot, ".zcode", "v2", "tasks-index.sqlite"));
  const zcodePaths = resolvePaths({
    home: root,
    appData: root,
    zcodeHome: join(zcodeRoot, ".zcode"),
  });
  const zcodeWriter = new ZcodeWriter(zcodePaths);
  const zcodeReader = new ZcodeReader(zcodePaths);
  const zcodeId = `sess_${"00000000-0000-4000-8000-000000000002"}`;
  const zcodeOut = await zcodeWriter.insert(makeDetail(2, "ZCode"), { nativeId: zcodeId, title: "M0 ZCode 测试" });
  const zcodeVerify = verifyZcode(zcodePaths, zcodeId, {
    messages: zcodeOut.nativeMessages,
    parts: zcodeOut.parts,
  });
  check("zcode.verify", zcodeVerify.ok, JSON.stringify(zcodeVerify.checks.filter((c) => !c.ok)));
  const zcodeRead = await zcodeReader.read(zcodeId);
  check("zcode.readback", zcodeRead.turns.length >= 2 && zcodeRead.parts.some((p) => p.kind === "tool_call"), `${zcodeRead.turns.length} turns`);
  await zcodeWriter.overwrite(makeDetail(3, "ZCode 覆盖"), zcodeId);
  const zcodeReRead = await zcodeReader.read(zcodeId);
  check("zcode.overwrite", zcodeReRead.turns.length >= 3, `${zcodeReRead.turns.length} turns`);
  zcodeWriter.remove(zcodeId);
  check("zcode.remove", (await zcodeReader.scan()).every((session) => session.nativeId !== zcodeId), "session removed");

  // ------------------------------------------------------- real content, temp DB
  const realSession = (await qoderReader.scan.call(new QoderReader(live))).find((s) => s.title === "你好");
  if (realSession) {
    const before = createHash("sha256").update(readFileSync(realSession.rawRef)).digest("hex");
    const realReader = new QoderReader(live);
    const detail = await realReader.read(realSession.nativeId);
    const imported = await zcodeWriter.insert(detail, {
      nativeId: `sess_${"00000000-0000-4000-8000-000000000003"}`,
      title: detail.session.title,
      cwd: detail.session.cwd,
    });
    const after = createHash("sha256").update(readFileSync(realSession.rawRef)).digest("hex");
    check("real.source-untouched", before === after, realSession.rawRef);
    const back = await zcodeReader.read(imported.nativeId);
    check("real.qoder-to-zcode", back.turns.length >= 1 && back.parts.length >= 1, `${back.turns.length} turns / ${back.parts.length} parts`);
    zcodeWriter.remove(imported.nativeId);
  } else {
    console.log("SKIP  real content test: sample session not found");
  }

  // ---------------------------------------------------------------- cleanup
  const summary = {
    root,
    passed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
    limitations: [
      "Qoder/ZCode desktop list visibility was not exercised while the apps are running",
      "ZCode task-index rebuild by the app could not be observed headlessly",
    ],
  };
  console.log(JSON.stringify(summary, null, 2));
  rmSync(root, { recursive: true, force: true });
  if (summary.failed) process.exit(1);

}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

void statSync;
