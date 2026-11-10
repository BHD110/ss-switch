import type {
  HostId,
  HostStatus,
  ImportPlan,
  ImportPlanRequest,
  ImportResult,
  PartKind,
  StoredSession,
  TxSummary,
} from "@bridge/contracts";
import { useEffect, useMemo, useState } from "react";

import { bridge } from "../api";
import { fidelityLabel, HOST_LABEL, HOST_ORDER, num, shortPath } from "../format";
import { type MessageKey, useI18n } from "../i18n";

interface Props {
  open: boolean;
  source?: StoredSession;
  hosts: HostStatus[];
  sessions: StoredSession[];
  history: TxSummary[];
  onClose(): void;
  onDone(result?: ImportResult): void;
}

interface Candidate {
  host: HostId;
  nativeId: string;
  label: string;
}

const PART_KEY: Record<PartKind, MessageKey> = {
  text: "partText",
  reasoning: "partReasoning",
  tool_call: "partToolCall",
  tool_result: "partToolResult",
  attachment: "partAttachment",
  image: "partImage",
  system: "partSystem",
  step: "partStep",
  timeline: "partTimeline",
  file: "partFile",
};

export function SwitchSheet({ open, source, hosts, sessions, history, onClose, onDone }: Props) {
  const { lang, t } = useI18n();
  const [targetHost, setTargetHost] = useState<HostId>("zcode");
  const [mode, setMode] = useState<"new_copy" | "overwrite">("new_copy");
  const [targetNativeId, setTargetNativeId] = useState<string>("");
  const [plan, setPlan] = useState<ImportPlan>();
  const [result, setResult] = useState<ImportResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [allowRunning, setAllowRunning] = useState(false);
  const [checkAttempt, setCheckAttempt] = useState(0);

  const sourceRef = source ? `${source.host}:${source.nativeId}` : "";
  const sourceId = source?.id ?? "";
  const writableHosts = useMemo(() => {
    const writable = hosts.filter((host) => host.capabilities.writable).map((host) => host.id);
    return writable.length ? writable : HOST_ORDER;
  }, [hosts]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the selected session changes
  useEffect(() => {
    if (!open || !source) return;
    const options = writableHosts.filter((host) => host !== source.host);
    setTargetHost(options[0] ?? writableHosts[0] ?? "zcode");
    setMode("new_copy");
    setTargetNativeId("");
    setPlan(undefined);
    setResult(undefined);
    setError(undefined);
    setCopied(false);
    setAllowRunning(false);
  }, [open, sourceId]);

  const candidates = useMemo<Candidate[]>(() => {
    if (!source) return [];
    const found = new Map<string, Candidate>();
    for (const tx of history) {
      if (tx.state !== "committed") continue;
      const src = tx.src ?? "";
      const dst = tx.dst ?? "";
      if (src === sourceRef && dst.startsWith(`${targetHost}:`)) {
        const nativeId = dst.slice(targetHost.length + 1);
        const title = sessions.find(
          (item) => item.host === targetHost && item.nativeId === nativeId,
        )?.title;
        found.set(nativeId, {
          host: targetHost,
          nativeId,
          label: `${title ?? t("candidateTarget")} · ${nativeId.slice(0, 16)}`,
        });
      } else if (dst === sourceRef && src.startsWith(`${targetHost}:`)) {
        const nativeId = src.slice(targetHost.length + 1);
        const title = sessions.find(
          (item) => item.host === targetHost && item.nativeId === nativeId,
        )?.title;
        found.set(nativeId, {
          host: targetHost,
          nativeId,
          label: `${title ?? t("candidateOriginal")} · ${nativeId.slice(0, 16)}${t("candidateOriginalSuffix")}`,
        });
      }
    }
    return [...found.values()];
  }, [history, source?.id, sourceRef, targetHost, sessions, source, t]);

  useEffect(() => {
    if (!open || !source) return;
    if (mode === "overwrite" && !targetNativeId && candidates.length === 1) {
      setTargetNativeId(candidates[0]!.nativeId);
    }
  }, [open, mode, candidates, targetNativeId, source?.id, source]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: checkAttempt requests a fresh plan with the same inputs
  useEffect(() => {
    if (!open || !source || result) return;
    setPlan(undefined);
    setError(undefined);
    const request: ImportPlanRequest = {
      source: { host: source.host, nativeId: source.nativeId },
      targetHost,
      mode: mode === "overwrite" ? "overwrite" : "new_copy",
      locale: lang,
      ...(mode === "overwrite" && targetNativeId ? { targetNativeId } : {}),
      ...(allowRunning && mode === "new_copy" ? { allowRunningWrite: true } : {}),
    };
    let active = true;
    const timer = setTimeout(() => {
      bridge()
        .planImport(request)
        .then((nextPlan) => {
          if (active) setPlan(nextPlan);
        })
        .catch((cause: unknown) => {
          if (active) setError(String(cause));
        });
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [open, source, targetHost, mode, targetNativeId, allowRunning, checkAttempt, result, lang]);

  if (!open || !source) return null;

  const request: ImportPlanRequest = {
    source: { host: source.host, nativeId: source.nativeId },
    targetHost,
    mode: mode === "overwrite" ? "overwrite" : "new_copy",
    locale: lang,
    ...(mode === "overwrite" && targetNativeId ? { targetNativeId } : {}),
    ...(allowRunning && mode === "new_copy" ? { allowRunningWrite: true } : {}),
    title: source.title,
    cwd: source.cwd,
  };

  // The plan re-checks the target at request time, so a stale host status must
  // not keep the confirm button disabled after the app has been closed.
  const targetBusy = plan?.targetRunning ?? false;

  const blocked =
    !plan || busy || plan.blockers.length > 0 || (mode === "overwrite" && !plan.overwriteAllowed);

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const outcome = await bridge().runImport(request);
      setResult(outcome);
      if (!outcome.ok && outcome.error) setError(outcome.error);
      onDone(outcome);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const copyCommand = async (): Promise<void> => {
    if (!result) return;
    await bridge().openTarget(result);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const undo = async (): Promise<void> => {
    if (!result) return;
    setBusy(true);
    try {
      const outcome = await bridge().undo(result.txId);
      if (!outcome.ok) setError(outcome.error ?? t("undoFailed"));
      else {
        setResult(undefined);
        onDone();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <header className="sheet-head">
          <div>
            <div className="sheet-kicker">{t("copyKicker")}</div>
            <h2>{source.title || t("untitled")}</h2>
            <div className="sheet-sub">
              {HOST_LABEL[source.host]} · {shortPath(source.cwd, 2, t)}
            </div>
          </div>
          <button type="button" className="icon-button" onClick={onClose} title={t("close")}>
            {t("close")}
          </button>
        </header>

        {result ? (
          <div className="sheet-body">
            <div className={`result-box ${result.ok ? "ok" : "bad"}`}>
              <div className="result-title">
                {result.ok
                  ? t("copiedTo", { host: HOST_LABEL[result.targetHost] })
                  : t("copyFailed")}
              </div>
              {result.ok ? (
                <>
                  <div className="kv">
                    <span>{t("sessionId")}</span>
                    <span className="mono">{result.targetNativeId}</span>
                  </div>
                  <div className="kv">
                    <span>{t("copiedLabel")}</span>
                    <span>
                      {num(result.turns, lang)} {t("turnUnit", { n: result.turns })} ·{" "}
                      {num(result.parts, lang)} {t("partUnit", { n: result.parts })} ·{" "}
                      {fidelityLabel(result.fidelity, t)}
                    </span>
                  </div>
                  {result.backupDir && (
                    <div className="kv">
                      <span>{t("backupLocation")}</span>
                      <span className="mono truncate">{result.backupDir}</span>
                    </div>
                  )}
                  {result.openCommand && (
                    <div className="kv">
                      <span>{t("openCommand")}</span>
                      <span className="mono">{result.openCommand}</span>
                    </div>
                  )}
                </>
              ) : (
                <p>{result.error ?? error}</p>
              )}
              {result.warnings.length > 0 && (
                <ul className="warning-list">
                  {result.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="sheet-actions">
              {result.ok && (
                <>
                  {result.openCommand && (
                    <button type="button" className="primary" onClick={copyCommand}>
                      {copied ? t("cmdCopied") : t("copyOpenCommand")}
                    </button>
                  )}
                  <button type="button" className="ghost" onClick={undo} disabled={busy}>
                    {t("undoThisCopy")}
                  </button>
                </>
              )}
              <button type="button" className="ghost" onClick={onClose}>
                {t("done")}
              </button>
            </div>
          </div>
        ) : (
          <div className="sheet-body">
            <div className="field">
              <div className="field-label">{t("targetApp")}</div>
              <div className="segmented">
                {writableHosts.map((host) => (
                  <button
                    type="button"
                    key={host}
                    className={targetHost === host ? "seg active" : "seg"}
                    onClick={() => {
                      setTargetHost(host);
                      setTargetNativeId("");
                      setAllowRunning(false);
                    }}
                    disabled={host === source.host}
                  >
                    {HOST_LABEL[host]}
                  </button>
                ))}
              </div>
              {targetBusy && (
                <div className="field-hint">
                  {t("runningHint", { host: HOST_LABEL[targetHost] })}
                </div>
              )}
              {targetBusy && mode === "new_copy" && (
                <label className="radio running-write">
                  <input
                    type="checkbox"
                    checked={allowRunning}
                    onChange={(event) => setAllowRunning(event.target.checked)}
                  />
                  <span>
                    <strong>{t("allowRunningStrong")}</strong>
                    <em>{t("allowRunningBody", { host: HOST_LABEL[targetHost] })}</em>
                  </span>
                </label>
              )}
            </div>

            <div className="field">
              <div className="field-label">{t("howCopy")}</div>
              <label className="radio">
                <input
                  type="radio"
                  checked={mode === "new_copy"}
                  onChange={() => setMode("new_copy")}
                />
                <span>
                  <strong>{t("newCopyStrong")}</strong>
                  <em>{t("newCopyBody", { host: HOST_LABEL[targetHost] })}</em>
                </span>
              </label>
              <label className="radio">
                <input
                  type="radio"
                  checked={mode === "overwrite"}
                  onChange={() => setMode("overwrite")}
                  disabled={candidates.length === 0}
                />
                <span>
                  <strong>{t("overwriteStrong")}</strong>
                  <em>
                    {candidates.length
                      ? t("overwriteBodyAvailable")
                      : t("overwriteBodyUnavailable")}
                  </em>
                </span>
              </label>
              {mode === "overwrite" && candidates.length > 0 && (
                <select
                  className="select"
                  value={targetNativeId}
                  onChange={(event) => setTargetNativeId(event.target.value)}
                >
                  <option value="">{t("chooseOverwrite")}</option>
                  {candidates.map((candidate) => (
                    <option key={candidate.nativeId} value={candidate.nativeId}>
                      {candidate.label}
                    </option>
                  ))}
                </select>
              )}
              {mode === "overwrite" && plan && !plan.overwriteAllowed && plan.overwriteReason && (
                <div className="field-hint warn">{plan.overwriteReason}</div>
              )}
            </div>

            <div className="field">
              <div className="field-label">{t("planTitle")}</div>
              {plan ? (
                <div className="plan">
                  <div className="plan-row">
                    <span>{t("originalLabel")}</span>
                    <span>
                      {num(plan.turns, lang)} {t("turnUnit", { n: plan.turns })} ·{" "}
                      {num(plan.parts, lang)} {t("partUnit", { n: plan.parts })} ·{" "}
                      {num(plan.toolCalls, lang)} {t("callUnit", { n: plan.toolCalls })}
                    </span>
                  </div>
                  <div className="plan-row">
                    <span>{t("copyResultLabel")}</span>
                    <span className={`fidelity ${plan.fidelity}`}>
                      {fidelityLabel(plan.fidelity, t)}
                    </span>
                  </div>
                  <div className="plan-row">
                    <span>{t("backupLabel")}</span>
                    <span>{plan.backupNote}</span>
                  </div>
                  {plan.dropped.length > 0 && (
                    <div className="plan-dropped">
                      <span className="hint">{t("droppedHint")}</span>
                      {plan.dropped.map((item) => (
                        <span key={item.kind} className="badge drop">
                          {PART_KEY[item.kind as PartKind]
                            ? t(PART_KEY[item.kind as PartKind])
                            : t("partOther")}{" "}
                          × {item.count}
                        </span>
                      ))}
                    </div>
                  )}
                  {plan.warnings.length > 0 && (
                    <ul className="warning-list">
                      {plan.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  )}
                  {plan.blockers.length > 0 && (
                    <ul className="warning-list bad">
                      {plan.blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                !error && (
                  <div className="field-hint">
                    {t("checking", { host: HOST_LABEL[targetHost] })}
                  </div>
                )
              )}
            </div>

            {error && (
              <div className="error-box" title={error}>
                {plan ? t("errorWithPlan") : t("errorNoPlan")}
              </div>
            )}

            <div className="sheet-actions">
              <button type="button" className="primary" onClick={confirm} disabled={blocked}>
                {busy
                  ? t("copying")
                  : mode === "overwrite"
                    ? t("confirmOverwrite")
                    : t("confirmCopy")}
              </button>
              {(error || (targetBusy && Boolean(plan?.blockers.length))) && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setCheckAttempt((n) => n + 1)}
                  disabled={busy}
                >
                  {t("recheck")}
                </button>
              )}
              <button type="button" className="ghost" onClick={onClose} disabled={busy}>
                {t("cancel")}
              </button>
            </div>
            <div className="hint">{t("afterCopyHint", { host: HOST_LABEL[targetHost] })}</div>
          </div>
        )}
      </div>
    </div>
  );
}
