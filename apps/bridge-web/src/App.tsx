import type {
  DivergenceInfo,
  HostId,
  HostStatus,
  ScanReport,
  SessionDetail,
  SessionRef,
  StoredSession,
  TxSummary,
} from "@bridge/contracts";
import { History, Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { bridge, hasBridge } from "./api";
import { HistoryPanel } from "./components/HistoryPanel";
import { HostRail } from "./components/HostRail";
import { SessionList } from "./components/SessionList";
import { SessionPreview } from "./components/SessionPreview";
import { SwitchSheet } from "./components/SwitchSheet";
import { HOST_LABEL } from "./format";
import { useI18n } from "./i18n";

type Theme = "dark" | "light";

const LANGUAGE_FLAGS = {
  en: new URL("./assets/flags/us.svg", import.meta.url).href,
  zh: new URL("./assets/flags/cn.svg", import.meta.url).href,
};

export function App() {
  const { lang, setLang, t } = useI18n();
  const langRef = useRef(lang);
  langRef.current = lang;
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
    return stored === "dark" ? "dark" : "light";
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
      const report: ScanReport = await bridge().scan(force, langRef.current);
      setHosts(report.hosts);
      setScannedAt(report.scannedAt);
      const [list, transactions] = await Promise.all([
        bridge().sessions({ limit: 1200 }),
        bridge()
          .history()
          .catch(() => undefined),
      ]);
      setSessions(list);
      if (transactions) setHistory(transactions);
      if (report.warnings.length) {
        setToast(report.warnings.join(langRef.current === "zh" ? "；" : "; "));
      }
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

  const openFolder = useCallback(
    async (path: string) => {
      try {
        const outcome = await bridge().openFolder(path, lang);
        if (!outcome.ok) setToast(outcome.error ?? t("openFolderFailed"));
      } catch (cause) {
        setToast(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [lang, t],
  );

  const openSessionFolder = useCallback(
    async (ref: SessionRef) => {
      const api = bridge();
      if (!api.openSessionFolder) {
        setToast(t("workdirDesktopOnly"));
        return;
      }
      try {
        const outcome = await api.openSessionFolder(ref, lang);
        if (!outcome.ok) setToast(outcome.error ?? t("openWorkdirFailed"));
      } catch (cause) {
        setToast(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [lang, t],
  );

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
        if (!outcome.ok) setToast(outcome.error ?? t("undoFailed"));
        else {
          setToast(t("undoDone"));
          await refreshMeta();
          await refresh(true);
        }
      } finally {
        setBusyTx("");
      }
    },
    [refresh, refreshMeta, t],
  );

  return (
    <div className="app">
      <HostRail
        hosts={hosts}
        activeHost={activeHost}
        scannedAt={scannedAt}
        onSelect={setActiveHost}
        onRefresh={() => void refresh(true)}
        busy={scanning}
      />
      <main className="workspace">
        <div className="topbar">
          <div className="crumbs">
            <h1>{activeHost === "all" ? t("allSessions") : HOST_LABEL[activeHost]}</h1>
            {!ready && <span className="badge bad">{t("desktopOnly")}</span>}
          </div>
          <div className="top-actions">
            {divergence.length > 0 && (
              <span className="badge branch" title={t("divergenceTitle")}>
                {t("divergenceBadge", { n: divergence.length })}
              </span>
            )}
            <button
              type="button"
              className="ghost language-button"
              onClick={() => setLang(lang === "zh" ? "en" : "zh")}
              title={t("langSwitchTitle")}
              aria-label={`${t("langSwitchTitle")}: ${t("langSwitchLabel")}`}
            >
              <img
                className="language-flag"
                src={lang === "zh" ? LANGUAGE_FLAGS.en : LANGUAGE_FLAGS.zh}
                alt=""
                width="20"
                height="15"
              />
              {t("langSwitchLabel")}
            </button>
            <button
              type="button"
              className="ghost square-button"
              onClick={() => setHistoryOpen(true)}
              title={t("history")}
              aria-label={t("history")}
            >
              <History aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ghost square-button"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              title={theme === "dark" ? t("lightMode") : t("darkMode")}
              aria-label={theme === "dark" ? t("lightMode") : t("darkMode")}
            >
              {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
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
            writable={
              selected
                ? (hosts.find((host) => host.id === selected.host)?.capabilities.writable ?? true)
                : true
            }
            onSwitch={() => setSheetOpen(true)}
            onOpenFolder={(ref) => void openSessionFolder(ref)}
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
              t("copiedToast", {
                host: HOST_LABEL[result.targetHost],
                id: result.targetNativeId ?? "",
              }),
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
