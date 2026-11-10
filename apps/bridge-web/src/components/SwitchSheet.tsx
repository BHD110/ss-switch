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

const PART_LABEL: Record<PartKind, string> = {
  text: "文字",
  reasoning: "思考过程",
  tool_call: "工具调用",
  tool_result: "工具结果",
  attachment: "附件",
  image: "图片",
  system: "系统消息",
  step: "步骤记录",
  timeline: "时间线",
  file: "文件",
};

export function SwitchSheet({ open, source, hosts, sessions, history, onClose, onDone }: Props) {
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
          label: `${title ?? "目标会话"} · ${nativeId.slice(0, 16)}`,
        });
      } else if (dst === sourceRef && src.startsWith(`${targetHost}:`)) {
        const nativeId = src.slice(targetHost.length + 1);
        const title = sessions.find(
          (item) => item.host === targetHost && item.nativeId === nativeId,
        )?.title;
        found.set(nativeId, {
          host: targetHost,
          nativeId,
          label: `${title ?? "原始会话"} · ${nativeId.slice(0, 16)}（原会话）`,
        });
      }
    }
    return [...found.values()];
  }, [history, source?.id, sourceRef, targetHost, sessions, source]);

  const targetStatus = hosts.find((host) => host.id === targetHost);

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
  }, [open, source, targetHost, mode, targetNativeId, allowRunning, checkAttempt, result]);

  if (!open || !source) return null;

  const request: ImportPlanRequest = {
    source: { host: source.host, nativeId: source.nativeId },
    targetHost,
    mode: mode === "overwrite" ? "overwrite" : "new_copy",
    ...(mode === "overwrite" && targetNativeId ? { targetNativeId } : {}),
    ...(allowRunning && mode === "new_copy" ? { allowRunningWrite: true } : {}),
    title: source.title,
    cwd: source.cwd,
  };

  // The plan re-checks the target at request time, so a stale host status must
  // not keep the confirm button disabled after the app has been closed.
  const targetBusy = plan
    ? plan.requiresRestart || plan.blockers.some((item) => item.includes("正在运行"))
    : targetStatus?.writeBlockedReason?.includes("正在运行");

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
      if (!outcome.ok) setError(outcome.error ?? "撤销失败");
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
            <div className="sheet-kicker">复制会话</div>
            <h2>{source.title || "未命名会话"}</h2>
            <div className="sheet-sub">
              {HOST_LABEL[source.host]} · {shortPath(source.cwd, 2)}
            </div>
          </div>
          <button type="button" className="icon-button" onClick={onClose} title="关闭">
            关闭
          </button>
        </header>

        {result ? (
          <div className="sheet-body">
            <div className={`result-box ${result.ok ? "ok" : "bad"}`}>
              <div className="result-title">
                {result.ok ? `已复制到 ${HOST_LABEL[result.targetHost]}` : "复制失败"}
              </div>
              {result.ok ? (
                <>
                  <div className="kv">
                    <span>会话编号</span>
                    <span className="mono">{result.targetNativeId}</span>
                  </div>
                  <div className="kv">
                    <span>已复制</span>
                    <span>
                      {num(result.turns)} 轮 · {num(result.parts)} 条 ·{" "}
                      {fidelityLabel(result.fidelity)}
                    </span>
                  </div>
                  {result.backupDir && (
                    <div className="kv">
                      <span>备份位置</span>
                      <span className="mono truncate">{result.backupDir}</span>
                    </div>
                  )}
                  {result.openCommand && (
                    <div className="kv">
                      <span>打开命令</span>
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
                      {copied ? "命令已复制" : "复制打开命令"}
                    </button>
                  )}
                  <button type="button" className="ghost" onClick={undo} disabled={busy}>
                    撤销这次复制
                  </button>
                </>
              )}
              <button type="button" className="ghost" onClick={onClose}>
                完成
              </button>
            </div>
          </div>
        ) : (
          <div className="sheet-body">
            <div className="field">
              <div className="field-label">复制到哪个应用？</div>
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
              {targetBusy && <div className="field-hint">{HOST_LABEL[targetHost]} 正在运行。</div>}
              {targetBusy && mode === "new_copy" && (
                <label className="radio running-write">
                  <input
                    type="checkbox"
                    checked={allowRunning}
                    onChange={(event) => setAllowRunning(event.target.checked)}
                  />
                  <span>
                    <strong>继续复制，稍后重启应用（实验功能）</strong>
                    <em>
                      重启 {HOST_LABEL[targetHost]}{" "}
                      后就能查看新会话。如果找不到，请退出应用后再复制一次。
                    </em>
                  </span>
                </label>
              )}
            </div>

            <div className="field">
              <div className="field-label">怎么复制？</div>
              <label className="radio">
                <input
                  type="radio"
                  checked={mode === "new_copy"}
                  onChange={() => setMode("new_copy")}
                />
                <span>
                  <strong>新建会话</strong>
                  <em>在 {HOST_LABEL[targetHost]} 新建一份，保留原会话。</em>
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
                  <strong>覆盖已有会话</strong>
                  <em>
                    {candidates.length
                      ? "只能覆盖上次复制后没有改动的会话。"
                      : "没有可覆盖的会话，请选择「新建会话」。"}
                  </em>
                </span>
              </label>
              {mode === "overwrite" && candidates.length > 0 && (
                <select
                  className="select"
                  value={targetNativeId}
                  onChange={(event) => setTargetNativeId(event.target.value)}
                >
                  <option value="">请选择要覆盖的会话</option>
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
              <div className="field-label">复制前确认</div>
              {plan ? (
                <div className="plan">
                  <div className="plan-row">
                    <span>原会话</span>
                    <span>
                      {num(plan.turns)} 轮 · {num(plan.parts)} 条 · {num(plan.toolCalls)} 次工具调用
                    </span>
                  </div>
                  <div className="plan-row">
                    <span>复制效果</span>
                    <span className={`fidelity ${plan.fidelity}`}>
                      {fidelityLabel(plan.fidelity)}
                    </span>
                  </div>
                  <div className="plan-row">
                    <span>备份</span>
                    <span>{plan.backupNote}</span>
                  </div>
                  {plan.dropped.length > 0 && (
                    <div className="plan-dropped">
                      <span className="hint">这些内容不会复制</span>
                      {plan.dropped.map((item) => (
                        <span key={item.kind} className="badge drop">
                          {PART_LABEL[item.kind as PartKind] ?? "其他内容"} × {item.count}
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
                  <div className="field-hint">正在检查能否复制到 {HOST_LABEL[targetHost]}…</div>
                )
              )}
            </div>

            {error && (
              <div className="error-box" title={error}>
                {plan ? "复制时出了点问题，请重试。" : "暂时无法检查能否复制，请重新检查。"}
              </div>
            )}

            <div className="sheet-actions">
              <button type="button" className="primary" onClick={confirm} disabled={blocked}>
                {busy ? "正在复制…" : mode === "overwrite" ? "确认覆盖" : "确认复制"}
              </button>
              {(error || (targetBusy && Boolean(plan?.blockers.length))) && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setCheckAttempt((n) => n + 1)}
                  disabled={busy}
                >
                  重新检查
                </button>
              )}
              <button type="button" className="ghost" onClick={onClose} disabled={busy}>
                取消
              </button>
            </div>
            <div className="hint">复制完成后，打开 {HOST_LABEL[targetHost]} 查看会话。</div>
          </div>
        )}
      </div>
    </div>
  );
}
