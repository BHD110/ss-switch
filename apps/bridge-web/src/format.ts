import type { HostId } from "@bridge/contracts";

export const HOST_LABEL: Record<HostId, string> = {
  qoder: "Qoder",
  zcode: "ZCode",
  codex: "Codex",
  workbuddy: "WorkBuddy",
};

export const HOST_ORDER: HostId[] = ["qoder", "zcode", "codex", "workbuddy"];

export function shortPath(path: string, keep = 2): string {
  if (!path) return "（无工作目录）";
  const parts = path.split(String.fromCharCode(92)).join("/").split("/").filter(Boolean);
  return parts.length <= keep ? path : `…/${parts.slice(-keep).join("/")}`;
}

export function timeAgo(ms: number): string {
  if (!ms) return "—";
  const delta = Date.now() - ms;
  if (delta < 0) return formatTime(ms);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "刚刚";
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`;
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`;
  if (delta < 30 * day) return `${Math.floor(delta / day)} 天前`;
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

export function num(value: number | undefined): string {
  if (value === undefined || value === null) return "—";
  return value.toLocaleString("zh-CN");
}

export function stateLabel(state: string): string {
  switch (state) {
    case "prepared":
      return "已准备";
    case "writing":
      return "写入中";
    case "verifying":
      return "校验中";
    case "committed":
      return "已完成";
    case "failed":
      return "失败";
    case "rolled_back":
      return "已撤销";
    default:
      return state;
  }
}

export function fidelityLabel(fidelity: string): string {
  switch (fidelity) {
    case "high":
      return "可保留对话内容";
    case "adapted":
      return "部分内容的显示方式可能不同";
    case "view_only":
      return "仅查看";
    default:
      return fidelity;
  }
}
