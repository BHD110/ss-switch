import type { DivergenceInfo, TxSummary } from "@bridge/contracts";

import { HOST_LABEL, formatTime, stateLabel } from "../format";

interface Props {
  open: boolean;
  history: TxSummary[];
  divergence: DivergenceInfo[];
  busyTx: string;
  onClose(): void;
  onUndo(txId: string): void;
  onOpenFolder(path: string): void;
}

export function HistoryPanel({ open, history, divergence, busyTx, onClose, onUndo, onOpenFolder }: Props) {
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet wide" onClick={(event) => event.stopPropagation()}>
        <header className="sheet-head">
          <div>
            <div className="sheet-kicker">导入记录</div>
            <h2>历史与回滚</h2>
            <div className="sheet-sub">每次写入都有独立备份；撤销只移除 Bridge 创建的目标。</div>
          </div>
          <button className="icon-button" onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="sheet-body">
          <div className="field-label">分叉提示</div>
          {divergence.length === 0 ? (
            <div className="field-hint">没有检测到导入后的新内容。</div>
          ) : (
            <div className="divergence-list">
              {divergence.map((item) => (
                <div key={`${item.lineageId}-${item.detectedAt}`} className="divergence-row">
                  <span className="badge branch">
                    {HOST_LABEL[item.srcHost]} ↔ {HOST_LABEL[item.dstHost]}
                  </span>
                  <span>
                    {item.srcChanged ? "源端已继续" : ""}
                    {item.srcChanged && item.dstChanged ? " · " : ""}
                    {item.dstChanged ? "目标端已继续" : ""}
                  </span>
                  <span className="hint">{formatTime(item.detectedAt)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="field-label">事务</div>
          <div className="tx-list">
            {history.length === 0 && <div className="field-hint">还没有导入记录。</div>}
            {history.map((tx) => (
              <div key={tx.id} className="tx-row">
                <span className={`tx-state ${tx.state}`}>{stateLabel(tx.state)}</span>
                <span className="mono truncate">{tx.src ?? "—"}</span>
                <span className="arrow">→</span>
                <span className="mono truncate">{tx.dst ?? "—"}</span>
                <span className="hint">{formatTime(tx.startedAt)}</span>
                {tx.backupDir && (
                  <button className="ghost-link" onClick={() => onOpenFolder(tx.backupDir!)}>
                    备份
                  </button>
                )}
                {tx.state === "committed" && (
                  <button
                    className="ghost-link danger"
                    onClick={() => onUndo(tx.id)}
                    disabled={busyTx === tx.id}
                  >
                    {busyTx === tx.id ? "撤销中…" : "撤销"}
                  </button>
                )}
                {tx.error && <span className="tx-error" title={tx.error}>{tx.error}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}