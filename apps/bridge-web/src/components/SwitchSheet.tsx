import type {
  HostId,
  HostStatus,
  ImportPlan,
  ImportPlanRequest,
  ImportResult,
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
    const timer = setTimeout(() => {
      bridge()
        .planImport(request)
        .then(setPlan)
        .catch((cause: unknown) => setError(String(cause)));
    }, 350);
    return () => clearTimeout(timer);
  }, [open, source?.id, targetHost, mode, targetNativeId, source?.host, source?.nativeId, source]);

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
  const targetBusy =
    (plan?.blockers.some((item) => /running|运行/i.test(item)) ?? false) ||
    (plan?.requiresRestart ?? false);

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
            <div className="sheet-kicker">复制分支</div>
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
                    <span>目标会话</span>
                    <span className="mono">{result.targetNativeId}</span>
                  </div>
                  <div className="kv">
                    <span>写入内容</span>
                    <span>
                      {num(result.turns)} 轮 · {num(result.parts)} 条 ·{" "}
                      {fidelityLabel(result.fidelity)}
                    </span>
                  </div>
                  {result.backupDir && (
                    <div className="kv">
                      <span>备份目录</span>
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
                  <button type="button" className="primary" onClick={copyCommand}>
                    {copied ? "命令已复制" : "复制打开命令"}
                  </button>
                  <button type="button" className="ghost" onClick={undo} disabled={busy}>
                    撤销这次导入
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
              <div className="field-label">目标 Agent</div>
              <div className="segmented">
                {writableHosts.map((host) => (
                  <button
                    type="button"
                    key={host}
                    className={targetHost === host ? "seg active" : "seg"}
                    onClick={() => {
                      setTargetHost(host);
                      setTargetNativeId("");
                    }}
                    disabled={host === source.host}
                  >
                    {HOST_LABEL[host]}
                  </button>
                ))}
              </div>
              {targetStatus && !targetStatus.writeReady && (
                <div className="field-hint">
                  扫描时状态：{targetStatus.writeBlockedReason ?? "目标暂不可写"}
                  （重新检查计划时会再次确认）
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
                    <strong>仍然写入（需重启目标应用）</strong>
                    <em>
                      实验性：立即写库，目标启动后才能看到。若目标退出时回写索引，可能需要在下次启动后重新复制。
                    </em>
                  </span>
                </label>
              )}
            </div>

            <div className="field">
              <div className="field-label">写入方式</div>
              <label className="radio">
                <input
                  type="radio"
                  checked={mode === "new_copy"}
                  onChange={() => setMode("new_copy")}
                />
                <span>
                  <strong>新建副本</strong>
                  <em>目标端生成新会话，源会话完全不动</em>
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
                  <em>只允许覆盖自上次导入后没有新内容的会话</em>
                </span>
              </label>
              {mode === "overwrite" && candidates.length > 0 && (
                <select
                  className="select"
                  value={targetNativeId}
                  onChange={(event) => setTargetNativeId(event.target.value)}
                >
                  <option value="">选择要被覆盖的会话…</option>
                  {candidates.map((candidate) => (
                    <option key={candidate.nativeId} value={candidate.nativeId}>
                      {candidate.label}
                    </option>
                  ))}
                </select>
              )}
              {mode === "overwrite" && candidates.length === 0 && (
                <div className="field-hint">这个会话还没有 Bridge 导入记录，只能新建副本。</div>
              )}
              {mode === "overwrite" && plan && !plan.overwriteAllowed && plan.overwriteReason && (
                <div className="field-hint warn">{plan.overwriteReason}</div>
              )}
            </div>

            <div className="field">
              <div className="field-label">将要写入</div>
              {plan ? (
                <div className="plan">
                  <div className="plan-row">
                    <span>轮次 / 内容</span>
                    <span>
                      {num(plan.turns)} 轮 · {num(plan.parts)} 条 · {num(plan.toolCalls)} 次工具调用
                    </span>
                  </div>
                  <div className="plan-row">
                    <span>保真度</span>
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
                      {plan.dropped.map((item) => (
                        <span key={item.kind} className="badge drop">
                          {item.kind} × {item.count}
                        </span>
                      ))}
                      <span className="hint">目标端没有对应格式，会被丢弃</span>
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
                <div className="field-hint">正在检查目标写入条件…</div>
              )}
            </div>

            {error && <div className="error-box">{error}</div>}

            <div className="sheet-actions">
              <button type="button" className="primary" onClick={confirm} disabled={blocked}>
                {busy ? "写入中…" : mode === "overwrite" ? "覆盖并写入" : "写入新副本"}
              </button>
              <button type="button" className="ghost" onClick={onClose} disabled={busy}>
                取消
              </button>
            </div>
            <div className="hint">
              写入前会自动备份目标数据库；写入后需要重启目标 Agent
              才能看到新会话。源会话不会被修改。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
