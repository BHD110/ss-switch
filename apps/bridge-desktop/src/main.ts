import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  IPC,
  type HostId,
  type HostStatus,
  type ImportPlanRequest,
  type ImportResult,
  type ScanReport,
  type SessionRef,
  type SessionQuery,
} from "@bridge/contracts";
import { BridgeStore } from "@bridge/store";
import {
  createAdapters,
  createWriters,
  isWritableHost,
  resolvePaths,
  type HostPaths,
} from "@bridge/hosts";
import { detectDivergence, planImport, runImport, undoImport, writerReadiness, type ImportContext } from "@bridge/migrate";

declare const __dirname: string;

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}
`;
  try {
    appendFileSync(process.env.BRIDGE_LOG ?? "bridge.log", line);
  } catch {
    // Logging must never break startup.
  }
  console.log(message);
}

app.setName("ss switch");

const paths: HostPaths = resolvePaths(
  process.env.BRIDGE_CONFIG_ROOT
    ? {
        qoderConfigDir: join(process.env.BRIDGE_CONFIG_ROOT, ".qoder-cn"),
        codexHome: join(process.env.BRIDGE_CONFIG_ROOT, ".codex"),
        zcodeHome: join(process.env.BRIDGE_CONFIG_ROOT, ".zcode"),
        workbuddyHome: join(process.env.BRIDGE_CONFIG_ROOT, ".workbuddy"),
      }
    : {},
);

let store: BridgeStore | undefined;
let context: ImportContext | undefined;
let window: BrowserWindow | undefined;
let scanAt = 0;

function bridgeContext(): ImportContext {
  if (context) return context;
  const userData = app.getPath("userData");
  mkdirSyncSafe(userData);
  store = new BridgeStore(join(userData, "bridge.db"));
  // Bump when normalization changes so stale cached transcripts are not reused.
  const PARSER_VERSION = "2";
  if (store.getSetting("parser_version") !== PARSER_VERSION) {
    store.clearDetailCache();
    store.setSetting("parser_version", PARSER_VERSION);
  }
  context = {
    paths,
    adapters: createAdapters(paths),
    writers: createWriters(paths),
    store,
    backupRoot: join(userData, "backups"),
  };
  return context;
}

function mkdirSyncSafe(path: string): void {
  mkdirSync(path, { recursive: true });
}

async function hostStatuses(ctx: ImportContext): Promise<HostStatus[]> {
  const statuses = await Promise.all(
    (Object.keys(ctx.adapters) as HostId[]).map(async (id) => {
      try {
        return await ctx.adapters[id].status();
      } catch (error) {
        const adapter = ctx.adapters[id];
        return {
          id,
          displayName: adapter.displayName,
          installed: false,
          detected: false,
          root: paths[id === "qoder" ? "qoderConfigDir" : id === "codex" ? "codexHome" : id === "zcode" ? "zcodeHome" : "workbuddyHome"],
          sessionCount: 0,
          writeReady: false,
          writeBlockedReason: error instanceof Error ? error.message : String(error),
          capabilities: adapter.capabilities,
        } satisfies HostStatus;
      }
    }),
  );
  const readiness = await writerReadiness(ctx);
  for (const status of statuses) {
    const write = readiness[status.id];
    if (!write) {
      status.writeReady = false;
      status.writeBlockedReason = "Read-only in this version";
    } else {
      status.writeReady = write.ready;
      status.writeBlockedReason = write.reason;
    }
    ctx.store.upsertHost(status);
  }
  return statuses;
}

async function scanAll(ctx: ImportContext, force: boolean): Promise<ScanReport> {
  if (!force && Date.now() - scanAt < 10_000) {
    const hosts = await hostStatuses(ctx);
    return { hosts, scannedAt: scanAt, warnings: [] };
  }
  const warnings: string[] = [];
  const hosts = await Promise.all(
    (Object.keys(ctx.adapters) as HostId[]).map(async (id) => {
      const adapter = ctx.adapters[id];
      try {
        const sessions = await adapter.scan();
        ctx.store.replaceSessionIndex(
          id,
          sessions,
          sessions.map((session) => session.nativeId),
        );
        const status = await adapter.status(sessions);
        status.sessionCount = sessions.length;
        return status;
      } catch (error) {
        warnings.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
        return {
          ...(await safeStatus(adapter.status, id)),
          sessionCount: 0,
        } as HostStatus;
      }
    }),
  );
  const readiness = await writerReadiness(ctx);
  for (const status of hosts) {
    const write = readiness[status.id];
    status.writeReady = Boolean(write?.ready);
    status.writeBlockedReason = write?.reason ?? (status.id === "qoder" || status.id === "zcode" ? undefined : "Read-only in this version");
    ctx.store.upsertHost(status);
  }
  scanAt = Date.now();
  return { hosts, scannedAt: scanAt, warnings };
}

async function safeStatus(
  fn: () => Promise<HostStatus>,
  id: HostId,
): Promise<HostStatus> {
  try {
    return await fn();
  } catch {
    return {
      id,
      displayName: id,
      installed: false,
      detected: false,
      root: "",
      sessionCount: 0,
      writeReady: false,
      capabilities: { readable: false, writable: false, desktopWritable: false, losses: [] },
    };
  }
}

function assertSessionRef(ref: unknown): SessionRef {
  const value = ref as SessionRef | undefined;
  if (!value || typeof value.nativeId !== "string" || !value.nativeId) {
    throw new Error("Invalid session reference");
  }
  if (!["qoder", "codex", "zcode", "workbuddy"].includes(value.host)) {
    throw new Error("Unknown host");
  }
  return value;
}

function registerIpc(): void {
  ipcMain.handle(IPC.scan, async (_event, force?: boolean) => scanAll(bridgeContext(), Boolean(force)));

  ipcMain.handle(IPC.hosts, async () => hostStatuses(bridgeContext()));

  ipcMain.handle(IPC.sessions, async (_event, query?: SessionQuery) => {
    const ctx = bridgeContext();
    return ctx.store.listSessions(query ?? {});
  });

  ipcMain.handle(IPC.sessionDetail, async (_event, rawRef: unknown) => {
    const ctx = bridgeContext();
    const ref = assertSessionRef(rawRef);
    const session = ctx.store.getSession(ref.host, ref.nativeId);
    const fingerprint = session?.fingerprint ?? "";
    const cached = session ? ctx.store.cachedDetail(session.id, fingerprint) : undefined;
    if (cached) return cached;
    const detail = await ctx.adapters[ref.host].read(ref.nativeId);
    ctx.store.saveDetail(detail, detail.warnings);
    return detail;
  });

  ipcMain.handle(IPC.planImport, async (_event, request: ImportPlanRequest) => {
    const ctx = bridgeContext();
    return planImport(ctx, request);
  });

  ipcMain.handle(IPC.runImport, async (_event, request: ImportPlanRequest) => {
    const ctx = bridgeContext();
    return runImport(ctx, request);
  });

  ipcMain.handle(IPC.history, async () => bridgeContext().store.listTx());

  ipcMain.handle(IPC.undo, async (_event, txId: string) => {
    const ctx = bridgeContext();
    return undoImport(ctx, txId);
  });

  ipcMain.handle(IPC.openTarget, async (_event, result: ImportResult) => {
    if (!result?.openCommand) return { ok: false, error: "No open command for this target" };
    clipboard.writeText(result.openCommand);
    return { ok: true };
  });

  ipcMain.handle(IPC.openFolder, async (_event, rawPath: string) => {
    if (typeof rawPath !== "string" || !rawPath) return { ok: false, error: "Empty path" };
    const target = resolve(rawPath);
    const allowed = [
      paths.qoderConfigDir,
      paths.codexHome,
      paths.zcodeHome,
      paths.workbuddyHome,
      app.getPath("userData"),
    ].map((root) => resolve(root));
    if (!allowed.some((root) => target === root || target.startsWith(`${root}${sep()}`))) {
      return { ok: false, error: "Path is outside the configured host roots" };
    }
    if (!existsSync(target)) return { ok: false, error: "Folder no longer exists" };
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle(IPC.divergence, async () => detectDivergence(bridgeContext()));

  ipcMain.handle(IPC.appInfo, async () => ({
    version: app.getVersion(),
    userData: app.getPath("userData"),
    home: homedir(),
  }));
}

function sep(): string {
  return process.platform === "win32" ? "\\" : "/";
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: "#1b211d",
    title: "ss switch",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      offscreen: Boolean(process.env.BRIDGE_CAPTURE),
      backgroundThrottling: false,
    },
  });
  window.once("ready-to-show", () => {
    if (process.env.BRIDGE_CAPTURE) return;
    window?.show();
  });

  window.webContents.on("did-finish-load", () => log("window loaded"));
  window.webContents.on("did-fail-load", (_event, code, description, url) => {
    log(`failed to load ${url}: ${code} ${description}`);
  });
  window.webContents.on("console-message", (...args: unknown[]) => {
    const details = args[1];
    if (details && typeof details === "object") {
      const record = details as { level?: string; message?: string };
      log(`[renderer:${record.level ?? "?"}] ${record.message ?? ""}`);
      return;
    }
    log(`[renderer:${String(args[1])}] ${String(args[2] ?? "")}`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[bridge] renderer gone: ${details.reason}`);
  });

  const devUrl = process.env.BRIDGE_DEV_URL;
  if (devUrl) {
    log(`loading dev url ${devUrl}`);
    await window.loadURL(devUrl);
  } else {
    const target = join(__dirname, "..", "..", "bridge-web", "dist", "index.html");
    log(`loading ${target}`);
    await window.loadFile(target);
  }
  log("load resolved");

  const capture = process.env.BRIDGE_CAPTURE;
  if (capture) {
    const delay = Number(process.env.BRIDGE_CAPTURE_DELAY ?? 15000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    const action = process.env.BRIDGE_CAPTURE_ACTION;
    if (action) {
      const script =
        action === "sheet"
          ? `(async () => { document.querySelectorAll(".session-card")[0]?.click(); await new Promise(r => setTimeout(r, 2500)); document.querySelector(".preview-actions .primary")?.click(); return "sheet"; })()`
          : action.startsWith("select:")
            ? `document.querySelectorAll(".session-card")[${Number(action.slice(7))}]?.click(); "select"`
            : action.startsWith("host:")
              ? `[...document.querySelectorAll(".session-card")].find((c) => c.querySelector('.host-chip')?.getAttribute('data-host') === ${JSON.stringify(action.slice(5))})?.click(); "host"`
              : "";
      if (script) {
        await window.webContents.executeJavaScript(script).catch((error) => log(`action failed: ${error}`));
        await new Promise((resolve) => setTimeout(resolve, 3500));
      }
    }
    const image = await window.webContents.capturePage();
    await mkdir(join(capture, ".."), { recursive: true });
    await writeFile(capture, image.toPNG());
    log(`captured ${capture} (${image.getSize().width}x${image.getSize().height})`);
    app.quit();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.whenReady().then(async () => {
    log("app ready");
    registerIpc();
    try {
      await createWindow();
    } catch (error) {
      log(`createWindow failed: ${error instanceof Error ? error.stack : String(error)}`);
    }
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    store?.close();
    store = undefined;
  });
}

export type { HostStatus };