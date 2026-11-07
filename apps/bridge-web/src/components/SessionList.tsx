import type { DivergenceInfo, HostId, StoredSession } from "@bridge/contracts";

import { HOST_LABEL, num, shortPath, timeAgo } from "../format";

interface Props {
  sessions: StoredSession[];
  selected?: { host: HostId; nativeId: string };
  text: string;
  onText(value: string): void;
  onSelect(session: StoredSession): void;
  divergence: DivergenceInfo[];
}

export function SessionList({ sessions, selected, text, onText, onSelect, divergence }: Props) {
  const groups = new Map<string, StoredSession[]>();
  for (const session of sessions) {
    const key = session.cwd || "（无工作目录）";
    const list = groups.get(key) ?? [];
    list.push(session);
    groups.set(key, list);
  }
  const branched = new Set(divergence.map((item) => item.lineageId));
  return (
    <section className="list-pane">
      <div className="list-head">
        <input
          className="search"
          value={text}
          onChange={(event) => onText(event.target.value)}
          placeholder="按标题或工作目录筛选"
          spellCheck={false}
        />
        <span className="list-count">{num(sessions.length)} 个会话</span>
      </div>
      <div className="session-scroll">
        {sessions.length === 0 && (
          <div className="empty">
            <div className="empty-title">没有匹配的会话</div>
            <p>换一个关键词，或点击右上角刷新。</p>
          </div>
        )}
        {[...groups.entries()].map(([cwd, items]) => (
          <div key={cwd} className="session-group">
            <div className="group-label" title={cwd}>
              {shortPath(cwd, 3)}
            </div>
            {items.map((session) => {
              const isSelected =
                selected?.host === session.host && selected.nativeId === session.nativeId;
              return (
                <button
                  key={session.id}
                  className={`session-card ${isSelected ? "selected" : ""}`}
                  onClick={() => onSelect(session)}
                >
                  <div className="card-top">
                    <span className="host-chip" data-host={session.host}>
                      {HOST_LABEL[session.host]}
                    </span>
                    <span className="card-title">{session.title || "未命名会话"}</span>
                  </div>
                  <div className="card-meta">
                    <span>{timeAgo(session.updatedAt)}</span>
                    {session.model && <span className="mono truncate">{session.model}</span>}
                    {!session.desktopVisible && <span className="badge cli">仅 CLI 可见</span>}
                    {session.lineageId && branched.has(session.lineageId) && (
                      <span className="badge branch">已分叉</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}