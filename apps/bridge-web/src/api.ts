import type { BridgeApi } from "@bridge/contracts";

declare global {
  interface Window {
    bridge?: BridgeApi;
  }
}

export function bridge(): BridgeApi {
  if (!window.bridge) {
    throw new Error("请在 Session Bridge 桌面应用中打开此界面（window.bridge 不可用）");
  }
  return window.bridge;
}

export const hasBridge = (): boolean => Boolean(window.bridge);
