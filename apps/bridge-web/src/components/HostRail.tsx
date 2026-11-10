import type { HostId, HostStatus } from "@bridge/contracts";

import { HOST_LABEL, HOST_ORDER, num, timeAgo } from "../format";

interface Props {
  hosts: HostStatus[];
  activeHost: HostId | "all";
  scannedAt: number;
  onSelect(host: HostId | "all"): void;
  onRefresh(): void;
  onOpenFolder(path: string): void;
  busy: boolean;
}

export function HostRail({
  hosts,
  activeHost,
  scannedAt,
  onSelect,
  onRefresh,
  onOpenFolder,
  busy,
}: Props) {
  const ordered = HOST_ORDER.map((id) => hosts.find((host) => host.id === id)).filter(
    (host): host is HostStatus => Boolean(host),
  );
  const total = ordered.reduce((sum, host) => sum + host.sessionCount, 0);
  return (
    <aside className="rail">
      <div className="rail-head">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <div className="brand-name">ss switch</div>
            <div className="brand-sub">会话中转站</div>
          </div>
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
        onClick={() => onSelect("all")}
      >
        <span className="host-dot" data-host="all" />
        <span className="host-name">全部会话</span>
        <span className="host-count">{num(total)}</span>
      </button>

      <div className="rail-label">Agent</div>
      <div className="host-list">
        {ordered.map((host) => (
          <div key={host.id} className={`host-row ${activeHost === host.id ? "active" : ""}`}>
            <button type="button" className="host-main" onClick={() => onSelect(host.id)}>
              <span className="host-dot" data-host={host.id} />
              <span className="host-name">
                {HOST_LABEL[host.id]}
                {!host.detected && <span className="host-missing">未安装</span>}
              </span>
              <span className="host-count">{num(host.sessionCount)}</span>
              <span className="host-meta" title={host.writeBlockedReason ?? ""}>
                <span className={host.writeReady ? "write-dot ok" : "write-dot"} />
                {host.capabilities.writable ? (host.writeReady ? "可写入" : "暂不可写") : "只读"}
                {host.version ? ` · ${host.version}` : ""}
              </span>
              <span className="host-root" title={host.root}>
                {host.root}
              </span>
            </button>
            <button
              type="button"
              className="ghost-link"
              title="打开该 Agent 的数据目录"
              onClick={() => onOpenFolder(host.root)}
              disabled={!host.detected}
            >
              目录
            </button>
          </div>
        ))}
      </div>

      <div className="rail-foot">
        <div>上次扫描 {scannedAt ? timeAgo(scannedAt) : "—"}</div>
        <div className="hint">只读展示四个 Agent；任意两个 Agent 之间都能复制分支。</div>
      </div>
    </aside>
  );
}
