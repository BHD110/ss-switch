import type { HostId, SessionDetail, SessionRef, StoredPart, StoredTurn } from "@bridge/contracts";
import { useMemo, useState } from "react";

import { formatTime, HOST_LABEL, num, shortPath } from "../format";

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

export function SessionPreview({
  detail,
  loading,
  error,
  selectedHost,
  writable = true,
  onSwitch,
  onOpenFolder,
}: Props) {
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
        <div className="preview-empty">正在读取会话…</div>
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
          <div className="empty-title">选择一个会话</div>
          <p>左侧列出四个 Agent 的本地会话。选中后可查看对话，并复制到任意另一个 Agent 继续。</p>
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
          <h2>{session.title || "未命名会话"}</h2>
        </div>
        <div className="preview-meta">
          <span className="mono" title={session.cwd}>
            {shortPath(session.cwd, 3)}
          </span>
          <span>更新于 {formatTime(session.updatedAt)}</span>
          <span>
            {num(turns.length)} 轮 · {num(detail.parts.length)} 条内容
          </span>
          {!session.desktopVisible && <span className="badge cli">仅 CLI 可见</span>}
        </div>
        <div className="preview-actions">
          <button type="button" className="primary" onClick={onSwitch} disabled={!canSwitch}>
            复制到…
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!session.cwd}
            title={session.cwd ? undefined : "该会话没有记录工作目录"}
            onClick={() => onOpenFolder({ host: session.host, nativeId: session.nativeId })}
          >
            打开工作目录
          </button>
        </div>
        {!canSwitch && (
          <div className="note">
            {HOST_LABEL[session.host]} 当前不可写入；请先退出目标应用或检查数据目录。
          </div>
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
            继续加载 · 还有 {turns.length - visible} 轮
          </button>
        )}
        {turns.length === 0 && <div className="preview-empty">这个会话没有可读的消息。</div>}
      </div>
      {selectedHost && <span className="hidden">{selectedHost}</span>}
    </section>
  );
}

function TurnView({ turn, parts }: { turn: StoredTurn; parts: StoredPart[] }) {
  return (
    <article className="turn">
      <div className="turn-head">
        <span className="turn-ord">#{turn.ord + 1}</span>
        <span>{formatTime(turn.startedAt)}</span>
        {turn.outcome && (
          <span className="turn-outcome">
            {turn.outcome === "completed"
              ? "完成"
              : turn.outcome === "tool-calls"
                ? "工具调用"
                : "失败"}
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
  const payload = (part.payload ?? {}) as Record<string, unknown>;
  switch (part.kind) {
    case "text":
      return (
        <div className={`part text ${part.role}`}>
          <div className="part-role">{part.role === "user" ? "你" : "助手"}</div>
          <div className="part-text">{part.text}</div>
        </div>
      );
    case "reasoning":
      return (
        <details className="part details reasoning">
          <summary>思考过程 · {part.text ? `${part.text.length} 字` : "无文本"}</summary>
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
            <span className="tool-state">{toolStateLabel(part.toolState)}</span>
          </div>
          <details>
            <summary>输入</summary>
            <pre className="pre">{pretty(input)}</pre>
          </details>
          {output !== undefined && String(output).length > 0 && (
            <details>
              <summary>输出 · {String(output).length} 字</summary>
              <pre className="pre">{clip(String(output))}</pre>
            </details>
          )}
        </div>
      );
    }
    case "tool_result":
      return (
        <details className="part details small">
          <summary>工具结果</summary>
          <pre className="pre">{clip(part.text ?? "")}</pre>
        </details>
      );
    case "attachment":
    case "image":
    case "file":
      return (
        <div className="part chip-row">
          <span className="badge">{part.kind}</span>
          <span className="mono truncate">
            {part.text ?? String(payload.path ?? payload.filename ?? "")}
          </span>
        </div>
      );
    default:
      return (
        <details className="part details small">
          <summary>{part.kind}</summary>
          <pre className="pre">{pretty(part.payload)}</pre>
        </details>
      );
  }
}

function toolStateLabel(state?: string): string {
  switch (state) {
    case "error":
      return "出错";
    case "running":
      return "运行中";
    case "pending":
      return "等待中";
    default:
      return "完成";
  }
}

function pretty(value: unknown): string {
  if (typeof value === "string") return clip(value);
  try {
    return clip(JSON.stringify(value, null, 2));
  } catch {
    return String(value);
  }
}

function clip(value: string): string {
  const MAX = 12_000;
  return value.length > MAX ? `${value.slice(0, MAX)}\n…（已截断，共 ${value.length} 字）` : value;
}
