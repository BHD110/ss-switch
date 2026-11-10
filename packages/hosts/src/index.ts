import type { HostId } from "@bridge/contracts";

import { CodexReader } from "./codex/read";
import { CodexWriter } from "./codex/write";
import { QoderReader } from "./qoder/read";
import { QoderWriter } from "./qoder/write";
import type { HostAdapter, HostPaths, HostWriter } from "./types";
import { WorkbuddyReader } from "./workbuddy/read";
import { WorkbuddyWriter } from "./workbuddy/write";
import { ZcodeReader } from "./zcode/read";
import { ZcodeWriter } from "./zcode/write";

export { CodexReader } from "./codex/read";
export { CodexWriter } from "./codex/write";
export * from "./paths";
export { QoderReader } from "./qoder/read";
export { QoderWriter } from "./qoder/write";
export * from "./types";
export * from "./util";
export { WorkbuddyReader } from "./workbuddy/read";
export { WorkbuddyWriter } from "./workbuddy/write";
export { ZcodeReader } from "./zcode/read";
export { ZcodeWriter } from "./zcode/write";

export function createAdapters(paths: HostPaths): Record<HostId, HostAdapter> {
  return {
    qoder: new QoderReader(paths),
    codex: new CodexReader(paths),
    zcode: new ZcodeReader(paths),
    workbuddy: new WorkbuddyReader(paths),
  };
}

export function createWriters(paths: HostPaths): Partial<Record<HostId, HostWriter>> {
  return {
    qoder: new QoderWriter(paths),
    codex: new CodexWriter(paths),
    zcode: new ZcodeWriter(paths),
    workbuddy: new WorkbuddyWriter(paths),
  };
}

export function isWritableHost(host: HostId): boolean {
  return host === "qoder" || host === "codex" || host === "zcode" || host === "workbuddy";
}
