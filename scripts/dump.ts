import { WorkbuddyReader, QoderReader, CodexReader, ZcodeReader, resolvePaths } from "../packages/hosts/src/index";

async function main(): Promise<void> {
  const [host, id] = process.argv.slice(2);
  const paths = resolvePaths();
  const readers: Record<string, unknown> = {
    workbuddy: new WorkbuddyReader(paths),
    qoder: new QoderReader(paths),
    codex: new CodexReader(paths),
    zcode: new ZcodeReader(paths),
  };
  const reader = readers[host!] as { read(nativeId: string): Promise<import("../packages/contracts/src/index").SessionDetail> };
  const detail = await reader.read(id!);
  console.log("session", detail.session.title, detail.session.cwd);
  console.log("turns", detail.turns.length, "parts", detail.parts.length, "warnings", detail.warnings);
  for (const part of detail.parts.slice(0, 10)) {
    console.log(part.ord, part.kind, part.role, JSON.stringify((part.text ?? "").slice(0, 140)), "merged", part.mergedInto ?? "");
  }
}

void main();
