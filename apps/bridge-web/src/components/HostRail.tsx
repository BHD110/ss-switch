import type { HostId, HostStatus } from "@bridge/contracts";

import { HOST_LABEL, HOST_ORDER, num, timeAgo } from "../format";

const HOST_ICONS: Record<HostId, string> = {
  qoder: new URL("../assets/hosts/qoder.svg", import.meta.url).href,
  zcode: new URL("../assets/hosts/zcode.png", import.meta.url).href,
  codex: new URL("../assets/hosts/codex.svg", import.meta.url).href,
  workbuddy: new URL("../assets/hosts/workbuddy.svg", import.meta.url).href,
};

interface Props {
  hosts: HostStatus[];
  activeHost: HostId | "all";
  scannedAt: number;
  onSelect(host: HostId | "all"): void;
  onRefresh(): void;
  busy: boolean;
}

export function HostRail({ hosts, activeHost, scannedAt, onSelect, onRefresh, busy }: Props) {
  const ordered = HOST_ORDER.map((id) => hosts.find((host) => host.id === id)).filter(
    (host): host is HostStatus => Boolean(host),
  );
  const total = ordered.reduce((sum, host) => sum + host.sessionCount, 0);
  return (
    <aside className="rail">
      <div className="rail-head">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div className="brand-name">ss switch</div>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          disabled={busy}
          title="重新扫描四个 Agent"
        >
          {busy ? "扫描中" : "刷新"}
        </button>
      </div>

      <button
        type="button"
        className={`host-row all-row ${activeHost === "all" ? "active" : ""}`}
        aria-pressed={activeHost === "all"}
        onClick={() => onSelect("all")}
      >
        <span className="host-dot" aria-hidden="true" />
        <span className="host-name">全部会话</span>
        <span className="host-count">{num(total)}</span>
      </button>

      <div className="rail-label">Agent</div>
      <div className="host-list">
        {ordered.map((host) => (
          <button
            key={host.id}
            type="button"
            className={`host-row host-main ${activeHost === host.id ? "active" : ""}`}
            aria-pressed={activeHost === host.id}
            onClick={() => onSelect(host.id)}
          >
            <img className="host-icon" src={HOST_ICONS[host.id]} alt="" width="24" height="24" />
            <span className="host-name">
              {HOST_LABEL[host.id]}
              {!host.detected && <span className="host-missing">未安装</span>}
            </span>
            <span className="host-meta" title={host.writeBlockedReason ?? ""}>
              <span className={host.writeReady ? "write-dot ok" : "write-dot"} />
              {host.capabilities.writable ? (host.writeReady ? "可写入" : "暂不可写") : "只读"}
              {host.version ? ` · ${host.version}` : ""}
            </span>
            <span className="host-count">{num(host.sessionCount)}</span>
          </button>
        ))}
      </div>

      <div className="rail-foot">
        <div className="rail-status">
          <span className="status-dot" aria-hidden="true" />
          本地存储
        </div>
        <div>上次扫描 {scannedAt ? timeAgo(scannedAt) : "—"}</div>
      </div>
    </aside>
  );
}
