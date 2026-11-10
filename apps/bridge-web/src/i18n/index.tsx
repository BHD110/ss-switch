import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { en } from "./en";
import type { Lang, MessageEntry } from "./types";
import { type MessageKey, zh } from "./zh";

const STORAGE_KEY = "bridge-lang";

export type { Lang, MessageKey };

export type MessageParams = Record<string, string | number>;
export type Translate = (key: MessageKey, params?: MessageParams) => string;

interface I18nValue {
  lang: Lang;
  setLang(lang: Lang): void;
  t: Translate;
}

const I18nContext = createContext<I18nValue | undefined>(undefined);

function isLang(value: unknown): value is Lang {
  return value === "zh" || value === "en";
}

/** Stored choice first, then the system language, defaulting to Chinese. */
export function storedLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLang(stored)) return stored;
  } catch {
    // Storage can be unavailable; fall through to the system language.
  }
  if (typeof navigator === "undefined") return "zh";
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function pick(entry: MessageEntry | undefined, params?: MessageParams): string {
  if (entry === undefined) return "";
  if (typeof entry === "string") return entry;
  return params?.n === 1 ? entry.one : entry.other;
}

export function translate(lang: Lang, key: MessageKey, params?: MessageParams): string {
  const text = pick((lang === "zh" ? zh : en)[key], params);
  if (!params) return text;
  let output = text;
  for (const [name, value] of Object.entries(params)) {
    output = output.replaceAll(`{${name}}`, String(value));
  }
  return output;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(storedLang);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // The choice lasts for this window when storage is unavailable.
    }
  }, [lang]);

  const setLang = useCallback((next: Lang) => setLangState(next), []);
  const t = useCallback<Translate>((key, params) => translate(lang, key, params), [lang]);
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
