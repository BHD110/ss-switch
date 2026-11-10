import type {
  HostId,
  PartKind,
  SessionDetail,
  SessionRef,
  StoredPart,
  StoredTurn,
} from "@bridge/contracts";
import { useMemo, useState } from "react";

import { formatTime, HOST_LABEL, num, shortPath } from "../format";
import { type MessageKey, type Translate, useI18n } from "../i18n";

interface Props {
  detail?: SessionDetail;
  loading: boolean;
  error?: string;
  selectedHost?: HostId;
  writable?: boolean;
  onSwitch(): void;
  onOpenFolder(ref: SessionRef): void;
}

const FIRST_PAGE = 40;

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

export function SessionPreview({
  detail,
  loading,
  error,
  selectedHost,
  writable = true,
  onSwitch,
  onOpenFolder,
}: Props) {
  const { lang, t } = useI18n();
  const [visible, setVisible] = useState(FIRST_PAGE);
  const turns = useMemo(
    () => (detail ? [...detail.turns].sort((a, b) => a.ord - b.ord) : []),
    [detail],
  );
  const byTurn = useMemo(() => {
    const map = new Map<string, StoredPart[]>();
    for (const part of detail?.parts ?? []) {
      const list = map.get(part.turnId) ?? [];
      list.push(part);
      map.set(part.turnId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.ord - b.ord);
    return map;
  }, [detail]);

  if (loading && !detail) {
    return (
      <section className="preview-pane">
        <div className="preview-empty">{t("loadingSession")}</div>
      </section>
    );
  }
  if (error) {
    return (
      <section className="preview-pane">
        <div className="preview-empty error">{error}</div>
      </section>
    );
  }
  if (!detail) {
    return (
      <section className="preview-pane">
        <div className="preview-empty">
          <div className="empty-title">{t("pickSession")}</div>
          <p>{t("pickSessionBody")}</p>
        </div>
      </section>
    );
  }

  const session = detail.session;
  const canSwitch = writable;
  return (
    <section className="preview-pane">
      <header className="preview-head">
        <div className="preview-title-row">
          <span className="host-chip" data-host={session.host}>
            {HOST_LABEL[session.host]}
          </span>
          <h2>{session.title || t("untitled")}</h2>
        </div>
        <div className="preview-meta">
          <span className="mono" title={session.cwd}>
            {shortPath(session.cwd, 3, t)}
          </span>
          <span>{t("updatedAt", { time: formatTime(session.updatedAt) })}</span>
          <span>
            {num(turns.length, lang)} {t("turnUnit", { n: turns.length })} ·{" "}
            {num(detail.parts.length, lang)} {t("partContentUnit", { n: detail.parts.length })}
          </span>
          {!session.desktopVisible && <span className="badge cli">{t("cliOnly")}</span>}
        </div>
        <div className="preview-actions">
          <button type="button" className="primary" onClick={onSwitch} disabled={!canSwitch}>
            {t("copyTo")}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!session.cwd}
            title={session.cwd ? undefined : t("noCwdTitle")}
            onClick={() => onOpenFolder({ host: session.host, nativeId: session.nativeId })}
          >
            {t("openWorkdir")}
          </button>
        </div>
        {!canSwitch && (
          <div className="note">{t("notWritableNote", { host: HOST_LABEL[session.host] })}</div>
        )}
        {detail.warnings.length > 0 && (
          <div className="warnings">
            {detail.warnings.map((warning) => (
              <span key={warning}>{warning}</span>
            ))}
          </div>
        )}
      </header>

      <div className="timeline">
        {turns.slice(0, visible).map((turn) => (
          <TurnView key={turn.id} turn={turn} parts={byTurn.get(turn.id) ?? []} />
        ))}
        {turns.length > visible && (
          <button
            type="button"
            className="load-more"
            onClick={() => setVisible((value) => value + 60)}
          >
            {t("loadMore", { n: turns.length - visible })}
          </button>
        )}
        {turns.length === 0 && <div className="preview-empty">{t("noMessages")}</div>}
      </div>
      {selectedHost && <span className="hidden">{selectedHost}</span>}
    </section>
  );
}

function TurnView({ turn, parts }: { turn: StoredTurn; parts: StoredPart[] }) {
  const { t } = useI18n();
  return (
    <article className="turn">
      <div className="turn-head">
        <span className="turn-ord">#{turn.ord + 1}</span>
        <span>{formatTime(turn.startedAt)}</span>
        {turn.outcome && (
          <span className="turn-outcome">
            {turn.outcome === "completed"
              ? t("outcomeCompleted")
              : turn.outcome === "tool-calls"
                ? t("outcomeToolCalls")
                : t("outcomeFailed")}
          </span>
        )}
      </div>
      <div className="turn-body">
        {parts
          .filter((part) => !(part.kind === "tool_result" && part.mergedInto))
          .map((part) => (
            <PartView key={part.id} part={part} />
          ))}
      </div>
    </article>
  );
}

function PartView({ part }: { part: StoredPart }) {
  const { t } = useI18n();
  const payload = (part.payload ?? {}) as Record<string, unknown>;
  switch (part.kind) {
    case "text":
      return (
        <div className={`part text ${part.role}`}>
          <div className="part-role">
            {part.role === "user" ? t("roleUser") : t("roleAssistant")}
          </div>
          <div className="part-text">{part.text}</div>
        </div>
      );
    case "reasoning":
      return (
        <details className="part details reasoning">
          <summary>
            {part.text ? t("reasoningSummary", { n: part.text.length }) : t("reasoningEmpty")}
          </summary>
          <pre className="pre">{part.text ?? ""}</pre>
        </details>
      );
    case "tool_call": {
      const input = payload.input ?? payload.arguments ?? payload;
      const output = payload.result ?? payload.output;
      return (
        <div className="tool-card" data-state={part.toolState ?? "ok"}>
          <div className="tool-head">
            <span className="tool-dot" />
            <span className="tool-name">{part.toolName ?? "tool"}</span>
            <span className="tool-state">{toolStateLabel(part.toolState, t)}</span>
          </div>
          <details>
            <summary>{t("inputLabel")}</summary>
            <pre className="pre">{pretty(input, t)}</pre>
          </details>
          {output !== undefined && String(output).length > 0 && (
            <details>
              <summary>{t("outputSummary", { n: String(output).length })}</summary>
              <pre className="pre">{clip(String(output), t)}</pre>
            </details>
          )}
        </div>
      );
    }
    case "tool_result":
      return (
        <details className="part details small">
          <summary>{t("toolResult")}</summary>
          <pre className="pre">{clip(part.text ?? "", t)}</pre>
        </details>
      );
    case "attachment":
    case "image":
    case "file":
      return (
        <div className="part chip-row">
          <span className="badge">{t(PART_KEY[part.kind])}</span>
          <span className="mono truncate">
            {part.text ?? String(payload.path ?? payload.filename ?? "")}
          </span>
        </div>
      );
    default:
      return (
        <details className="part details small">
          <summary>{t("partOther")}</summary>
          <pre className="pre">{pretty(part.payload, t)}</pre>
        </details>
      );
  }
}

function toolStateLabel(state: string | undefined, t: Translate): string {
  switch (state) {
    case "error":
      return t("toolStateError");
    case "running":
      return t("toolStateRunning");
    case "pending":
      return t("toolStatePending");
    default:
      return t("toolStateDone");
  }
}

function pretty(value: unknown, t: Translate): string {
  if (typeof value === "string") return clip(value, t);
  try {
    return clip(JSON.stringify(value, null, 2), t);
  } catch {
    return String(value);
  }
}

function clip(value: string, t: Translate): string {
  const MAX = 12_000;
  return value.length > MAX
    ? `${value.slice(0, MAX)}\n${t("truncated", { n: value.length })}`
    : value;
}
