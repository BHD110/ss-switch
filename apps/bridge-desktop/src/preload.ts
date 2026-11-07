import { type BridgeApi, IPC } from "@bridge/contracts";
import { contextBridge, ipcRenderer } from "electron";

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api: BridgeApi = {
  scan: (force) => invoke(IPC.scan, force),
  hosts: () => invoke(IPC.hosts),
  sessions: (query) => invoke(IPC.sessions, query),
  sessionDetail: (ref) => invoke(IPC.sessionDetail, ref),
  planImport: (request) => invoke(IPC.planImport, request),
  runImport: (request) => invoke(IPC.runImport, request),
  history: () => invoke(IPC.history),
  undo: (txId) => invoke(IPC.undo, txId),
  openTarget: (result) => invoke(IPC.openTarget, result),
  openFolder: (path) => invoke(IPC.openFolder, path),
  divergence: () => invoke(IPC.divergence),
  appInfo: () => invoke(IPC.appInfo),
};

// contextBridge is required: the renderer never gets ipcRenderer itself.

contextBridge.exposeInMainWorld("bridge", api);
