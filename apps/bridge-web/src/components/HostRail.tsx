import type { HostId, HostStatus } from "@bridge/contracts";
import { RefreshCw } from "lucide-react";

import { HOST_LABEL, HOST_ORDER, num, timeAgo } from "../format";
import { useI18n } from "../i18n";

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
  const { lang, t } = useI18n();
  const ordered = HOST_ORDER.map((id) => hosts.find((host) => host.id === id)).filter(
    (host): host is HostStatus => Boolean(host),
  );
  const total = ordered.reduce((sum, host) => sum + host.sessionCount, 0);
  return (
    <aside className="rail">
      <div className="rail-head">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div className="brand-name">SS Switch</div>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          disabled={busy}
          title={t("rescanTitle")}
          aria-label={busy ? t("scanning") : t("rescanTitle")}
        >
          <RefreshCw aria-hidden="true" className={busy ? "spinning" : undefined} />
        </button>
      </div>

      <button
        type="button"
        className={`host-row all-row ${activeHost === "all" ? "active" : ""}`}
        aria-pressed={activeHost === "all"}
        onClick={() => onSelect("all")}
      >
        <span className="host-dot" aria-hidden="true" />
        <span className="host-name">{t("allSessions")}</span>
        <span className="host-count">{num(total, lang)}</span>
      </button>

      <div className="rail-label">{t("agent")}</div>
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
              {!host.detected && <span className="host-missing">{t("notInstalled")}</span>}
            </span>
            <span className="host-meta" title={host.writeBlockedReason ?? ""}>
              <span className={host.writeReady ? "write-dot ok" : "write-dot"} />
              {host.capabilities.writable
                ? host.writeReady
                  ? t("writable")
                  : t("unavailable")
                : t("readOnly")}
              {host.version ? ` · ${host.version}` : ""}
            </span>
            <span className="host-count">{num(host.sessionCount, lang)}</span>
          </button>
        ))}
      </div>

      <div className="rail-foot">
        <div className="rail-status">
          <span className="status-dot" aria-hidden="true" />
          {t("localStore")}
        </div>
        <div>{t("lastScan", { time: scannedAt ? timeAgo(scannedAt, t) : "—" })}</div>
      </div>
    </aside>
  );
}
