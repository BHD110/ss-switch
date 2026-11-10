import type { HostId } from "@bridge/contracts";

import type { Lang, Translate } from "./i18n";

export const HOST_LABEL: Record<HostId, string> = {
  qoder: "Qoder",
  zcode: "ZCode",
  codex: "Codex",
  workbuddy: "WorkBuddy",
};

export const HOST_ORDER: HostId[] = ["qoder", "zcode", "codex", "workbuddy"];

export function shortPath(path: string, keep: number, t: Translate): string {
  if (!path) return t("noCwd");
  const parts = path.split(String.fromCharCode(92)).join("/").split("/").filter(Boolean);
  return parts.length <= keep ? path : `…/${parts.slice(-keep).join("/")}`;
}

export function timeAgo(ms: number, t: Translate): string {
  if (!ms) return "—";
  const delta = Date.now() - ms;
  if (delta < 0) return formatTime(ms);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return t("justNow");
  if (delta < hour) return t("minutesAgo", { n: Math.floor(delta / minute) });
  if (delta < day) return t("hoursAgo", { n: Math.floor(delta / hour) });
  if (delta < 30 * day) return t("daysAgo", { n: Math.floor(delta / day) });
  return formatDate(ms);
}

export function formatDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatTime(ms: number): string {
  const date = new Date(ms);
  return `${formatDate(ms)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function num(value: number | undefined, lang: Lang): string {
  if (value === undefined || value === null) return "—";
  return value.toLocaleString(lang === "zh" ? "zh-CN" : "en-US");
}

export function stateLabel(state: string, t: Translate): string {
  switch (state) {
    case "prepared":
      return t("statePrepared");
    case "writing":
      return t("stateWriting");
    case "verifying":
      return t("stateVerifying");
    case "committed":
      return t("stateCommitted");
    case "failed":
      return t("stateFailed");
    case "rolled_back":
      return t("stateRolledBack");
    default:
      return state;
  }
}

export function fidelityLabel(fidelity: string, t: Translate): string {
  switch (fidelity) {
    case "high":
      return t("fidelityHigh");
    case "adapted":
      return t("fidelityAdapted");
    case "view_only":
      return t("fidelityViewOnly");
    default:
      return fidelity;
  }
}
