export type Lang = "zh" | "en";

/** A message can carry separate singular/plural forms for languages that need them. */
export type MessageEntry = string | { one: string; other: string };
