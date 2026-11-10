import type { DivergenceInfo, TxSummary } from "@bridge/contracts";

import { formatTime, HOST_LABEL, stateLabel } from "../format";
import { type Translate, useI18n } from "../i18n";

interface Props {
  open: boolean;
  history: TxSummary[];
  divergence: DivergenceInfo[];
  busyTx: string;
  onClose(): void;
  onUndo(txId: string): void;
  onOpenFolder(path: string): void;
}

function transactionTitle(tx: TxSummary, t: Translate): string {
  const source = tx.srcTitle?.trim();
  const target = tx.dstTitle?.trim();
  if (source && target && source !== target) return `${source} → ${target}`;
  return source || target || t("txUnnamed");
}

export function HistoryPanel({
  open,
  history,
  divergence,
  busyTx,
  onClose,
  onUndo,
  onOpenFolder,
}: Props) {
  const { t } = useI18n();
  if (!open) return null;
  const counts = new Map<string, number>();
  // History is newest first, so number matching titles from oldest to newest.
  const entries = history.toReversed().map((tx) => {
    const title = transactionTitle(tx, t);
    const number = (counts.get(title) ?? 0) + 1;
    counts.set(title, number);
    return { tx, title, number };
  });
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet wide" onClick={(event) => event.stopPropagation()}>
        <header className="sheet-head">
          <div>
            <h2>{t("historyTitle")}</h2>
            <div className="sheet-sub">{t("historySubtitle")}</div>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            {t("close")}
          </button>
        </header>
        <div className="sheet-body">
          <div className="field-label">{t("divergenceHint")}</div>
          {divergence.length === 0 ? (
            <div className="field-hint">{t("noDivergence")}</div>
          ) : (
            <div className="divergence-list">
              {divergence.map((item) => (
                <div key={`${item.lineageId}-${item.detectedAt}`} className="divergence-row">
                  <span className="badge branch">
                    {HOST_LABEL[item.srcHost]} ↔ {HOST_LABEL[item.dstHost]}
                  </span>
                  <span>
                    {item.srcChanged ? t("srcContinued") : ""}
                    {item.srcChanged && item.dstChanged ? " · " : ""}
                    {item.dstChanged ? t("dstContinued") : ""}
                  </span>
                  <span className="hint">{formatTime(item.detectedAt)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="field-label">{t("transactions")}</div>
          <div className="tx-list">
            {history.length === 0 && <div className="field-hint">{t("noImports")}</div>}
            {entries.reverse().map(({ tx, title, number }) => (
              <div key={tx.id} className="tx-row">
                <span className={`tx-state ${tx.state}`}>{stateLabel(tx.state, t)}</span>
                <span className="tx-title" title={title}>
                  <span>{title}</span>
                  {(counts.get(title) ?? 0) > 1 && <span>{t("txIndexSuffix", { n: number })}</span>}
                </span>
                <span className="hint tx-time">{formatTime(tx.startedAt)}</span>
                {tx.backupDir && (
                  <button
                    type="button"
                    className="ghost-link"
                    onClick={() => onOpenFolder(tx.backupDir!)}
                  >
                    {t("backupButton")}
                  </button>
                )}
                {tx.state === "committed" && (
                  <button
                    type="button"
                    className="ghost-link danger"
                    onClick={() => onUndo(tx.id)}
                    disabled={busyTx === tx.id}
                  >
                    {busyTx === tx.id ? t("undoing") : t("undoButton")}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
