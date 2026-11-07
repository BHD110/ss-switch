import type {
  DivergenceInfo,
  HostId,
  HostStatus,
  ScanReport,
  SessionDetail,
  StoredSession,
  TxSummary,
} from "@bridge/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { bridge, hasBridge } from "./api";
import { HistoryPanel } from "./components/HistoryPanel";
import { HostRail } from "./components/HostRail";
import { SessionList } from "./components/SessionList";
import { SessionPreview } from "./components/SessionPreview";
import { SwitchSheet } from "./components/SwitchSheet";
import { HOST_LABEL } from "./format";

type Theme = "dark" | "light";

export function App() {
  const [hosts, setHosts] = useState<HostStatus[]>([]);
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [activeHost, setActiveHost] = useState<HostId | "all">("all");
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<{ host: HostId; nativeId: string }>();
  const [detail, setDetail] = useState<SessionDetail>();
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [scanning, setScanning] = useState(false);
  const [scannedAt, setScannedAt] = useState(0);
  const [toast, setToast] = useState<string>();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<TxSummary[]>([]);
  const [divergence, setDivergence] = useState<DivergenceInfo[]>([]);
  const [busyTx, setBusyTx] = useState("");
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("bridge-theme");
    return stored === "light" ? "light" : "dark";
  });

  const ready = hasBridge();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("bridge-theme", theme);
  }, [theme]);

  const refresh = useCallback(async (force = true) => {
    if (!hasBridge()) return;
    setScanning(true);
    setToast(undefined);
    try {
      const report: ScanReport = await bridge().scan(force);
      setHosts(report.hosts);
      setScannedAt(report.scannedAt);
      const list = await bridge().sessions({ limit: 1200 });
      setSessions(list);
      if (report.warnings.length) setToast(report.warnings.join("；"));
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    if (!ready) return;
    bridge()
      .history()
      .then(setHistory)
      .catch(() => setHistory([]));
    bridge()
      .divergence()
      .then(setDivergence)
      .catch(() => setDivergence([]));
  }, [ready]);

  const filtered = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return sessions.filter((session) => {
      if (activeHost !== "all" && session.host !== activeHost) return false;
      if (!needle) return true;
      return (
        session.title.toLowerCase().includes(needle) ||
        session.cwd.toLowerCase().includes(needle) ||
        session.nativeId.toLowerCase().includes(needle)
      );
    });
  }, [sessions, activeHost, text]);

  const selectedSession = useMemo(
    () =>
      selected
        ? sessions.find(
            (session) => session.host === selected.host && session.nativeId === selected.nativeId,
          )
        : undefined,
    [sessions, selected],
  );

  const openSession = useCallback(async (session: StoredSession) => {
    setSelected({ host: session.host, nativeId: session.nativeId });
    setDetail(undefined);
    setDetailError(undefined);
    setLoadingDetail(true);
    try {
      const loaded = await bridge().sessionDetail({
        host: session.host,
        nativeId: session.nativeId,
      });
      setDetail(loaded);
    } catch (cause) {
      setDetailError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const openFolder = useCallback(async (path: string) => {
    try {
      const outcome = await bridge().openFolder(path);
      if (!outcome.ok) setToast(outcome.error ?? "无法打开目录");
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const refreshMeta = useCallback(async () => {
    const [tx, div] = await Promise.all([
      bridge()
        .history()
        .catch(() => []),
      bridge()
        .divergence()
        .catch(() => []),
    ]);
    setHistory(tx);
    setDivergence(div);
  }, []);

  const undo = useCallback(
    async (txId: string) => {
      setBusyTx(txId);
      try {
        const outcome = await bridge().undo(txId);
        if (!outcome.ok) setToast(outcome.error ?? "撤销失败");
        else {
          setToast("已撤销该次导入");
          await refreshMeta();
          await refresh(true);
        }
      } finally {
        setBusyTx("");
      }
    },
    [refresh, refreshMeta],
  );

  return (
    <div className="app">
      <HostRail
        hosts={hosts}
        activeHost={activeHost}
        scannedAt={scannedAt}
        onSelect={setActiveHost}
        onRefresh={() => void refresh(true)}
        onOpenFolder={(path) => void openFolder(path)}
        busy={scanning}
      />
      <main className="workspace">
        <div className="topbar">
          <div className="crumbs">
            {activeHost === "all" ? "全部会话" : HOST_LABEL[activeHost]}
            <span className="sep">/</span>
            <span className="muted">{filtered.length} 个</span>
            {!ready && <span className="badge bad">需要在桌面应用中运行</span>}
          </div>
          <div className="top-actions">
            {divergence.length > 0 && (
              <span className="badge branch" title="导入后两端各自有了新内容">
                {divergence.length} 条分叉
              </span>
            )}
            <button type="button" className="ghost" onClick={() => setHistoryOpen(true)}>
              历史
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? "浅色" : "深色"}
            </button>
          </div>
        </div>
        <div className="panes">
          <SessionList
            sessions={filtered}
            selected={selected}
            text={text}
            onText={setText}
            onSelect={(session) => void openSession(session)}
            divergence={divergence}
          />
          <SessionPreview
            detail={detail}
            loading={loadingDetail}
            error={detailError}
            selectedHost={selected?.host}
            onSwitch={() => setSheetOpen(true)}
            onOpenFolder={(path) => void openFolder(path)}
          />
        </div>
      </main>

      <SwitchSheet
        open={sheetOpen && Boolean(selectedSession)}
        source={selectedSession}
        hosts={hosts}
        sessions={sessions}
        history={history}
        onClose={() => setSheetOpen(false)}
        onDone={(result) => {
          if (result?.ok) {
            setToast(
              `已写入 ${HOST_LABEL[result.targetHost]}：${result.targetNativeId ?? ""}。重启目标应用后可在列表看到。`,
            );
          }
          void refreshMeta();
          void refresh(true);
        }}
      />
      <HistoryPanel
        open={historyOpen}
        history={history}
        divergence={divergence}
        busyTx={busyTx}
        onClose={() => setHistoryOpen(false)}
        onUndo={(txId) => void undo(txId)}
        onOpenFolder={(path) => void openFolder(path)}
      />
      {toast && (
        <div className="toast" onClick={() => setToast(undefined)}>
          {toast}
        </div>
      )}
    </div>
  );
}
