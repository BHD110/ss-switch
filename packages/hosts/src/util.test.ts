import { describe, expect, it } from "vitest";

import { cleanUserText, orderByChain, qoderProjectSlug, titleFromText } from "./util";

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
