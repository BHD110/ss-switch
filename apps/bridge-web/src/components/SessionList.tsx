import type { DivergenceInfo, HostId, StoredSession } from "@bridge/contracts";

import { HOST_LABEL, shortPath, timeAgo } from "../format";
import { useI18n } from "../i18n";

interface Props {
  sessions: StoredSession[];
  selected?: { host: HostId; nativeId: string };
  text: string;
  onText(value: string): void;
  onSelect(session: StoredSession): void;
  divergence: DivergenceInfo[];
}

export function SessionList({ sessions, selected, text, onText, onSelect, divergence }: Props) {
  const { t } = useI18n();
  const groups = new Map<string, StoredSession[]>();
  for (const session of sessions) {
    const key = session.cwd || t("noCwd");
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
          type="search"
          aria-label={t("filterAria")}
          value={text}
          onChange={(event) => onText(event.target.value)}
          placeholder={t("filterPlaceholder")}
          spellCheck={false}
        />
        <span className="list-count">{t("sessionCount", { n: sessions.length })}</span>
      </div>
      <div className="session-scroll">
        {sessions.length === 0 && (
          <div className="empty">
            <div className="empty-title">{t("noMatches")}</div>
            <p>{t("noMatchesHint")}</p>
          </div>
        )}
        {[...groups.entries()].map(([cwd, items]) => (
          <div key={cwd} className="session-group">
            <div className="group-label" title={cwd}>
              {shortPath(cwd, 3, t)}
            </div>
            {items.map((session) => {
              const isSelected =
                selected?.host === session.host && selected.nativeId === session.nativeId;
              return (
                <button
                  type="button"
                  key={session.id}
                  className={`session-card ${isSelected ? "selected" : ""}`}
                  aria-pressed={isSelected}
                  onClick={() => onSelect(session)}
                >
                  <div className="card-top">
                    <span className="card-title">{session.title || t("untitled")}</span>
                  </div>
                  <div className="card-meta">
                    <span className="host-chip" data-host={session.host}>
                      {HOST_LABEL[session.host]}
                    </span>
                    <span>{timeAgo(session.updatedAt, t)}</span>
                    {!session.desktopVisible && <span className="badge cli">{t("cliOnly")}</span>}
                    {session.lineageId && branched.has(session.lineageId) && (
                      <span className="badge branch">{t("branched")}</span>
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
