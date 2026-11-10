import { describe, expect, it } from "vitest";

import {
  cleanUserText,
  codexRolloutName,
  orderByChain,
  qoderProjectSlug,
  titleFromText,
  workbuddyProjectSlug,
} from "./util";

describe("cleanUserText", () => {
  it("prefers the explicit user query inside an envelope", () => {
    const raw = [
      '<system-reminder data-role="user-context">',
      "<user_info>OS: win32</user_info>",
      "lots of context",
      "</system-reminder>",
      "<user_query>可以看到 memhub 吗？</user_query>",
    ].join("\n");
    expect(cleanUserText(raw)).toBe("可以看到 memhub 吗？");
  });

  it("peels envelope blocks and keeps plain user text", () => {
    const raw = "<system-reminder>noise</system-reminder>\n请总结这个仓库。";
    expect(cleanUserText(raw)).toBe("请总结这个仓库。");
  });

  it("returns undefined when only context remains", () => {
    expect(cleanUserText("<system-reminder>only noise</system-reminder>")).toBeUndefined();
  });
});

describe("qoderProjectSlug", () => {
  it("replaces each non-alphanumeric character with one dash", () => {
    expect(qoderProjectSlug("D:\\项目\\hy-memory")).toBe("D-----hy-memory");
    expect(qoderProjectSlug("C:/Users/a/repo")).toBe("C--Users-a-repo");
  });
});

describe("workbuddyProjectSlug", () => {
  it("matches the folders the desktop already writes", () => {
    expect(workbuddyProjectSlug("c:\\Users\\a1866\\WorkBuddy\\2026-11-04-19-15-59")).toBe(
      "c-Users-a1866-WorkBuddy-2026-11-04-19-15-59",
    );
    expect(workbuddyProjectSlug("D:\\工作\\lcgf-obsidian\\创业\\创业")).toBe(
      "d-工作-lcgf-obsidian-创业-创业",
    );
    expect(
      workbuddyProjectSlug("d:\\codeSource\\product\\08-工具类\\C-Clean\\WindowsCleaner-7.5"),
    ).toBe("d-codeSource-product-08-工具类-C-Clean-WindowsCleaner-7.5");
  });
});

describe("codexRolloutName", () => {
  it("uses local time and the session id", () => {
    const created = new Date(2026, 10, 10, 14, 33, 9).getTime();
    expect(codexRolloutName(created, "01a1c429-17ba-7eb2-b71a-ac5139e82c57")).toBe(
      "rollout-2026-11-10T14-33-09-01a1c429-17ba-7eb2-b71a-ac5139e82c57.jsonl",
    );
  });
});

describe("orderByChain", () => {
  it("walks parents before children even when the file is unordered", () => {
    const ordered = orderByChain([
      { uuid: "b", parentUuid: "a" },
      { uuid: "a", parentUuid: null },
      { uuid: "c", parentUuid: "b" },
    ]);
    expect(ordered.map((item) => item.uuid)).toEqual(["a", "b", "c"]);
  });
});

describe("titleFromText", () => {
  it("flattens and truncates", () => {
    expect(titleFromText("line one\nline two")).toBe("line one line two");
    expect(titleFromText("x".repeat(200))?.length).toBe(90);
  });
});
