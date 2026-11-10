import type { BridgeApi } from "@bridge/contracts";

import { storedLang, translate } from "./i18n";

declare global {
  interface Window {
    bridge?: BridgeApi;
  }
}

export function bridge(): BridgeApi {
  if (!window.bridge) {
    throw new Error(translate(storedLang(), "desktopOnlyError"));
  }
  return window.bridge;
}

export const hasBridge = (): boolean => Boolean(window.bridge);
