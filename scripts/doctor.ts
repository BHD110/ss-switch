import { createAdapters, createWriters, resolvePaths } from "../packages/hosts/src/index";

async function main(): Promise<void> {
  const paths = resolvePaths();
  const adapters = createAdapters(paths);
  const writers = createWriters(paths);
  const report = {
    roots: {
      qoder: paths.qoderConfigDir,
      qoderDesktopDb: paths.qoderDesktopDb,
      codex: paths.codexHome,
      zcode: paths.zcodeHome,
      workbuddy: paths.workbuddyHome,
    },
    hosts: [] as unknown[],
    writes: {} as Record<string, unknown>,
  };
  for (const [id, adapter] of Object.entries(adapters)) {
    try {
      const status = await adapter.status();
      report.hosts.push({
        id,
        installed: status.installed,
        detected: status.detected,
        version: status.version ?? null,
        sessions: status.sessionCount,
        root: status.root,
        readable: status.capabilities.readable,
        writable: status.capabilities.writable,
      });
    } catch (error) {
      report.hosts.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const [id, writer] of Object.entries(writers)) {
    try {
      await writer.assertSchema();
      report.writes[id] = { ready: !(await writer.isBusy()), reason: "schema ok" };
    } catch (error) {
      report.writes[id] = {
        ready: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
