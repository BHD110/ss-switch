import type { HostId } from "@bridge/contracts";

import { CodexReader } from "./codex/read";
import { QoderReader } from "./qoder/read";
import { QoderWriter } from "./qoder/write";
import { WorkbuddyReader } from "./workbuddy/read";
import { ZcodeReader } from "./zcode/read";
import { ZcodeWriter } from "./zcode/write";
import type { HostAdapter, HostPaths, HostWriter } from "./types";

export * from "./types";
export * from "./paths";
export * from "./util";
export { QoderReader } from "./qoder/read";
export { QoderWriter } from "./qoder/write";
export { CodexReader } from "./codex/read";
export { ZcodeReader } from "./zcode/read";
export { ZcodeWriter } from "./zcode/write";
export { WorkbuddyReader } from "./workbuddy/read";

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
    zcode: new ZcodeWriter(paths),
  };
}

export function isWritableHost(host: HostId): host is "qoder" | "zcode" {
  return host === "qoder" || host === "zcode";
}