/** 主进程 / 渲染进程共享类型与 IPC 通道定义。 */

// ============ 模型配置 ============

export interface ModelProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

// ============ MCP 配置 ============

export type McpTransportType = 'stdio' | 'http';

export interface McpServerConfig {
  id: string;
  name: string;
  type: McpTransportType;
  enabled: boolean;
  command?: string; // stdio
  args?: string[];
  env?: Record<string, string>;
  url?: string; // http
  headers?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  exposedName: string; // 对 LLM 暴露的名字（带服务器前缀）
  description: string;
  inputSchema: unknown;
}

export type McpStatus = 'connecting' | 'connected' | 'error' | 'disabled';

export interface McpServerState {
  id: string;
  name: string;
  type: McpTransportType;
  builtin?: boolean;
  enabled: boolean;
  status: McpStatus;
  error?: string;
  tools: McpToolInfo[];
}

// ============ 知识库 ============

export interface KbSource {
  id: string;
  path: string;
  kind: 'file' | 'folder';
  fileCount: number;
  chunkCount: number;
  enabled: boolean;
  error?: string;
}

export interface KbSearchResult {
  sourcePath: string;
  title: string;
  chunkIndex: number;
  score: number;
  text: string;
}

export interface KbStats {
  sources: KbSource[];
  totalChunks: number;
  topK: number;
}

// ============ MIDI 资产 ============

export interface MidiAssetMeta {
  id: string;
  title: string;
  tempoBpm: number;
  barCount: number;
  noteCount: number;
  trackCount: number;
  durationSec: number;
  tracks: { index: number; name: string; program: number; noteCount: number; ccCounts: Record<string, number> }[];
  source: 'generated' | 'uploaded' | 'modified';
  parentIds?: string[];
  createdAt: number;
  sessionId?: string;
}

// ============ Agent 聊天 ============

export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  name?: string;
}

export type AgentEvent =
  | { type: 'run_start'; runId: string }
  | { type: 'text_delta'; runId: string; delta: string }
  | { type: 'reasoning_delta'; runId: string; delta: string }
  | { type: 'tool_start'; runId: string; toolCallId: string; toolName: string; argsJson: string }
  | { type: 'tool_end'; runId: string; toolCallId: string; toolName: string; ok: boolean; summary: string; midiAssets: MidiAssetMeta[]; resultPreview: string }
  | { type: 'iteration'; runId: string; index: number }
  | { type: 'done'; runId: string; finishReason?: string; usage?: TokenUsage }
  | { type: 'error'; runId: string; message: string };

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AgentRunRequest {
  runId: string;
  sessionId: string;
  messages: WireMessage[];
  profileId?: string;
  kbEnabled: boolean;
}

// ============ 应用信息 ============

export interface AppInfo {
  version: string;
  electron: string;
  node: string;
  platform: string;
}

// ============ IPC 通道 ============

export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsUpsertProfile: 'settings:upsertProfile',
  settingsRemoveProfile: 'settings:removeProfile',
  settingsTestProfile: 'settings:testProfile',
  mcpList: 'mcp:list',
  mcpAdd: 'mcp:add',
  mcpUpdate: 'mcp:update',
  mcpRemove: 'mcp:remove',
  mcpSetEnabled: 'mcp:setEnabled',
  mcpRestart: 'mcp:restart',
  mcpStates: 'mcp:states', // main -> renderer
  kbAddPaths: 'kb:addPaths',
  kbRemoveSource: 'kb:removeSource',
  kbSetSourceEnabled: 'kb:setSourceEnabled',
  kbRebuild: 'kb:rebuild',
  kbStats: 'kb:stats',
  kbSearch: 'kb:search',
  agentRun: 'agent:run',
  agentAbort: 'agent:abort',
  agentEvent: 'agent:event', // main -> renderer
  midiGet: 'midi:get',
  midiImportDialog: 'midi:importDialog',
  midiImportBytes: 'midi:importBytes',
  midiSaveAs: 'midi:saveAs',
  midiQuickDownload: 'midi:quickDownload',
  midiDrag: 'midi:drag',
  dialogPickKbFiles: 'dialog:pickKbFiles',
  dialogPickKbFolder: 'dialog:pickKbFolder',
  appInfo: 'app:info',
  uiError: 'ui:error', // main -> renderer
} as const;

export interface SettingsData {
  profiles: ModelProfile[];
  activeProfileId: string | null;
  mcpServers: McpServerConfig[];
  builtinMcpEnabled: boolean;
  kbTopK: number;
  agentMaxIterations: number;
  playTempo?: number; // 播放音量 0-1
  volume: number;
}
