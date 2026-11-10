import { type BridgeApi, IPC } from "@bridge/contracts";
import { contextBridge, ipcRenderer } from "electron";

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api: BridgeApi = {
  scan: (force, locale) => invoke(IPC.scan, force, locale),
  hosts: (locale) => invoke(IPC.hosts, locale),
  sessions: (query) => invoke(IPC.sessions, query),
  sessionDetail: (ref) => invoke(IPC.sessionDetail, ref),
  planImport: (request) => invoke(IPC.planImport, request),
  runImport: (request) => invoke(IPC.runImport, request),
  history: () => invoke(IPC.history),
  undo: (txId) => invoke(IPC.undo, txId),
  openTarget: (result) => invoke(IPC.openTarget, result),
  openFolder: (path, locale) => invoke(IPC.openFolder, path, locale),
  openSessionFolder: (ref, locale) => invoke(IPC.openSessionFolder, ref, locale),
  divergence: () => invoke(IPC.divergence),
  appInfo: () => invoke(IPC.appInfo),
};

// contextBridge is required: the renderer never gets ipcRenderer itself.

contextBridge.exposeInMainWorld("bridge", api);
