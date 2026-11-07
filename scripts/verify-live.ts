import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createAdapters, createWriters, resolvePaths } from "../packages/hosts/src/index";
import { backupTargets, createBackup } from "../packages/migrate/src/backup";
import { fixtureDetail } from "./fixture";

const markerPath = join(process.cwd(), ".tmp", "live-probe.json");
const backupRoot = join(process.cwd(), ".tmp", "live-backups");

interface Marker {
  createdAt: number;
  qoder?: { nativeId: string; file: string };
  zcode?: { nativeId: string };
  backups: string[];
}

function readMarker(): Marker | undefined {
  try {
    return JSON.parse(readFileSync(markerPath, "utf8")) as Marker;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  const paths = resolvePaths();
  const adapters = createAdapters(paths);
  const writers = createWriters(paths);
  const qoderWriter = writers.qoder!;
  const zcodeWriter = writers.zcode!;

  if (command === "prepare") {
    if (readMarker()) throw new Error("已有未清理的测试会话，请先运行 cleanup");
    const qoderBusy = await qoderWriter.isBusy();
    const zcodeBusy = await zcodeWriter.isBusy();
    if (qoderBusy || zcodeBusy) {
      throw new Error(
        `请先完全退出 Qoder（${qoderBusy ? "运行中" : "已退出"}）和 ZCode（${zcodeBusy ? "运行中" : "已退出"}），再运行 prepare`,
      );
    }
    await qoderWriter.assertSchema();
    await zcodeWriter.assertSchema();

    const stamp = Date.now();
    const qoderId = randomUUID();
    const zcodeId = `sess_${randomUUID()}`;
    const cwd = process.cwd();
    const qoderTarget = join(
      paths.qoderConfigDir,
      "projects",
      cwd.replace(/[^A-Za-z0-9]/g, "-"),
      `${qoderId}.jsonl`,
    );
    const backups = [
      (
        await createBackup(
          backupRoot,
          `qoder-${stamp}`,
          backupTargets("qoder", paths, [qoderTarget]),
        )
      ).dir,
      (await createBackup(backupRoot, `zcode-${stamp}`, backupTargets("zcode", paths))).dir,
    ];

    const detail = fixtureDetail({ cwd, title: "ss switch 可见性测试" });
    const qoderOut = await qoderWriter.insert(detail, {
      nativeId: qoderId,
      title: "ss switch 可见性测试",
      cwd,
    });
    const zcodeOut = await zcodeWriter.insert(detail, {
      nativeId: zcodeId,
      title: "ss switch 可见性测试",
      cwd,
    });
    const marker: Marker = {
      createdAt: stamp,
      qoder: { nativeId: qoderId, file: qoderTarget },
      zcode: { nativeId: zcodeOut.nativeId },
      backups,
    };
    mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
    writeFileSync(markerPath, JSON.stringify(marker, null, 2));
    console.log(
      [
        "已写入两条一次性测试会话：",
        `  Qoder   ${qoderOut.nativeId}`,
        `  ZCode   ${zcodeOut.nativeId}`,
        `备份：${backups.join("  ")}`,
        "",
        "下一步：打开 Qoder 和 ZCode 桌面，确认列表里出现“ss switch 可见性测试”。",
        "然后完全退出两个应用，运行：node .tmp/verify-live.cjs cleanup",
      ].join("\n"),
    );
    return;
  }

  if (command === "status") {
    const marker = readMarker();
    if (!marker) {
      console.log("没有进行中的可见性测试。先运行 prepare。");
      return;
    }
    const qoderSessions = await adapters.qoder.scan();
    const zcodeSessions = await adapters.zcode.scan();
    const qoder = qoderSessions.find((item) => item.nativeId === marker.qoder?.nativeId);
    const zcode = zcodeSessions.find((item) => item.nativeId === marker.zcode?.nativeId);
    console.log(
      JSON.stringify(
        {
          qoder: qoder
            ? { found: true, desktopVisible: qoder.desktopVisible, title: qoder.title }
            : { found: false },
          zcode: zcode ? { found: true, desktopVisible: zcode.desktopVisible } : { found: false },
          note: "desktopVisible=true 表示目标应用的列表/索引里已有这条会话",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "cleanup") {
    const marker = readMarker();
    if (!marker) {
      console.log("没有需要清理的测试会话。");
      return;
    }
    if ((await qoderWriter.isBusy()) || (await zcodeWriter.isBusy())) {
      throw new Error("请先完全退出 Qoder 和 ZCode，再运行 cleanup");
    }
    if (marker.qoder) qoderWriter.remove(marker.qoder.nativeId);
    if (marker.zcode) zcodeWriter.remove(marker.zcode.nativeId);
    writeFileSync(markerPath, JSON.stringify({ ...marker, cleanedAt: Date.now() }, null, 2));
    console.log("测试会话已删除，源会话未被修改。备份保留在 .tmp/live-backups。");
    return;
  }

  throw new Error("用法：verify-live prepare | status | cleanup");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

void existsSync;
