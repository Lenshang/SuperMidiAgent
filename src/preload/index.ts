/** Preload：向渲染进程暴露类型安全的 IPC API。 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, AgentEvent, McpServerState, SettingsData } from '../shared/types';

const listenAgentEvents = (callback: (event: AgentEvent) => void): (() => void) => {
  const listener = (_e: unknown, event: AgentEvent) => callback(event);
  ipcRenderer.on(IPC.agentEvent, listener);
  return () => ipcRenderer.removeListener(IPC.agentEvent, listener);
};

const listenMcpStates = (callback: (states: McpServerState[]) => void): (() => void) => {
  const listener = (_e: unknown, states: McpServerState[]) => callback(states);
  ipcRenderer.on(IPC.mcpStates, listener);
  return () => ipcRenderer.removeListener(IPC.mcpStates, listener);
};

const api = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),

  settingsGet: (): Promise<SettingsData> => ipcRenderer.invoke(IPC.settingsGet),
  settingsSet: (patch: Partial<SettingsData>) => ipcRenderer.invoke(IPC.settingsSet, patch),
  settingsUpsertProfile: (profile: Partial<import('../shared/types').ModelProfile>) =>
    ipcRenderer.invoke(IPC.settingsUpsertProfile, profile),
  settingsRemoveProfile: (id: string) => ipcRenderer.invoke(IPC.settingsRemoveProfile, id),
  settingsTestProfile: (profile: { baseUrl: string; apiKey: string; model: string }) =>
    ipcRenderer.invoke(IPC.settingsTestProfile, profile),

  mcpList: (): Promise<McpServerState[]> => ipcRenderer.invoke(IPC.mcpList),
  mcpAdd: (cfg: unknown) => ipcRenderer.invoke(IPC.mcpAdd, cfg),
  mcpUpdate: (cfg: unknown) => ipcRenderer.invoke(IPC.mcpUpdate, cfg),
  mcpRemove: (id: string) => ipcRenderer.invoke(IPC.mcpRemove, id),
  mcpSetEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC.mcpSetEnabled, { id, enabled }),
  mcpRestart: (id: string) => ipcRenderer.invoke(IPC.mcpRestart, id),
  onMcpStates: listenMcpStates,

  kbStats: () => ipcRenderer.invoke(IPC.kbStats),
  kbSearch: (query: string, topK?: number) => ipcRenderer.invoke(IPC.kbSearch, { query, topK }),
  kbAddPaths: (paths: string[]) => ipcRenderer.invoke(IPC.kbAddPaths, paths),
  kbRemoveSource: (id: string) => ipcRenderer.invoke(IPC.kbRemoveSource, id),
  kbSetSourceEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC.kbSetSourceEnabled, { id, enabled }),
  kbRebuild: () => ipcRenderer.invoke(IPC.kbRebuild),
  pickKbFiles: () => ipcRenderer.invoke(IPC.dialogPickKbFiles) as Promise<string[]>,
  pickKbFolder: () => ipcRenderer.invoke(IPC.dialogPickKbFolder) as Promise<string[]>,

  midiGet: (id: string) => ipcRenderer.invoke(IPC.midiGet, id),
  midiImportBytes: (bytes: ArrayBuffer, name: string, sessionId?: string) =>
    ipcRenderer.invoke(IPC.midiImportBytes, { bytes, name, sessionId }),
  midiImportDialog: () => ipcRenderer.invoke(IPC.midiImportDialog),
  midiSaveAs: (id: string, suggestedName?: string) => ipcRenderer.invoke(IPC.midiSaveAs, { id, suggestedName }),
  midiQuickDownload: (id: string, suggestedName?: string) => ipcRenderer.invoke(IPC.midiQuickDownload, { id, suggestedName }),
  midiDrag: (id: string, suggestedName?: string) => ipcRenderer.invoke(IPC.midiDrag, { id, suggestedName }),

  agentRun: (req: { runId: string; sessionId: string; messages: unknown[]; profileId?: string; kbEnabled: boolean }) =>
    ipcRenderer.invoke(IPC.agentRun, req),
  agentAbort: (runId: string) => ipcRenderer.invoke(IPC.agentAbort, runId),
  onAgentEvent: listenAgentEvents,
};

export type Api = typeof api;

contextBridge.exposeInMainWorld('api', api);
