import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

export async function fileMeta(path: string): Promise<{ mtimeMs: number; size: number }> {
  try {
    const info = await stat(path);
    return { mtimeMs: Math.floor(info.mtimeMs), size: info.size };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

export async function* readJsonl(path: string): AsyncGenerator<Record<string, unknown>> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const value = JSON.parse(trimmed);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          yield value as Record<string, unknown>;
        }
      } catch {
        // A truncated last line is expected while a host is still writing.
      }
    }
  } finally {
    lines.close();
    stream.close();
  }
}

/** ISO timestamps (Qoder/Codex) and epoch ms/seconds (ZCode/WorkBuddy) both appear. */
export function toMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return toMs(numeric);
  }
  return 0;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const result = str(value);
    if (result) return result;
  }
  return undefined;
}

export function truncate(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Title from the first human prompt; hosts that store a title win over this. */
export function titleFromText(text: string | undefined): string {
  if (!text) return "Untitled session";
  return truncate(text.replace(/<[^>]+>/g, " "), 90) || "Untitled session";
}

export function isUnder(child: string, parent: string): boolean {
  const normalizedChild = child.replace(/\\/g, "/").toLowerCase();
  const normalizedParent = parent.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

export function joinPath(...parts: string[]): string {
  return join(...parts);
}

/** Qoder project slug: every non-alphanumeric character becomes one dash. */
export function qoderProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Qoder and Claude Code style parent chain → chronological leaf order. */
export function orderByChain(
  records: { uuid: string; parentUuid?: string | null }[],
): { uuid: string; parentUuid?: string | null }[] {
  const byId = new Map(records.map((record) => [record.uuid, record]));
  const children = new Map<string, string[]>();
  for (const record of records) {
    if (!record.parentUuid) continue;
    const list = children.get(record.parentUuid) ?? [];
    list.push(record.uuid);
    children.set(record.parentUuid, list);
  }
  const roots = records.filter((record) => !record.parentUuid || !byId.has(record.parentUuid));
  const ordered: typeof records = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const record = byId.get(id);
    if (record) ordered.push(record);
    for (const childId of children.get(id) ?? []) walk(childId);
  };
  for (const root of roots) walk(root.uuid);
  for (const record of records) walk(record.uuid);
  return ordered;
}

export function stableId(host: string, nativeId: string): string {
  return `${host}:${nativeId}`;
}

export function clampText(text: string, max = 200_000): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`, truncated: true };
}
const ENVELOPE_BLOCKS = [
  /<system-reminder[\s\S]*?<\/system-reminder>/gi,
  /<user_info>[\s\S]*?<\/user_info>/gi,
  /<identity_context>[\s\S]*?<\/identity_context>/gi,
  /<environment_context[\s\S]*?<\/environment_context>/gi,
  /<project_context>[\s\S]*?<\/project_context>/gi,
  /<connector-status>[\s\S]*?<\/connector-status>/gi,
  /<user_custom_instructions>[\s\S]*?<\/user_custom_instructions>/gi,
  /<current_time>[\s\S]*?<\/current_time>/gi,
];

/**
 * Hosts wrap the real prompt in context envelopes. Prefer the explicit
 * `<user_query>` when present; otherwise peel known envelopes and keep the rest.
 */
export function cleanUserText(text: string): string | undefined {
  const query = text.match(/<user_query>([\s\S]*?)<\/user_query>/i);
  if (query?.[1]?.trim()) return query[1].trim();
  let cleaned = text;
  for (const pattern of ENVELOPE_BLOCKS) cleaned = cleaned.replace(pattern, "\n");
  cleaned = cleaned.replace(/<task-notification[\s\S]*?<\/task-notification>/gi, "\n");
  cleaned = cleaned.trim();
  return cleaned || undefined;
}
