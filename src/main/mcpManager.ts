/** MCP 连接管理：内置服务（进程内）+ 外部 stdio/HTTP 服务器。 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpServerState, McpServerConfig, McpToolInfo, McpStatus } from '../shared/types';
import { createBuiltinMidiServer } from './builtinMidiServer';
import { MidiStore } from './midiStore';

interface Connection {
  config: McpServerConfig;
  client: Client | null;
  status: McpStatus;
  error?: string;
  tools: McpToolInfo[];
  builtin?: boolean;
  onClose?: () => void;
}

export interface ToolRef {
  exposedName: string;
  serverId: string;
  toolName: string;
  description: string;
  inputSchema: unknown;
}

export class McpManager {
  private connections = new Map<string, Connection>();
  private sessionId: string | undefined;
  onStateChange: (() => void) | null = null;

  constructor(
    private store: MidiStore,
    private getSettings: () => { builtinMcpEnabled: boolean; mcpServers: McpServerConfig[] },
  ) {}

  setSessionId(id: string | undefined): void {
    this.sessionId = id;
  }

  async init(): Promise<void> {
    await this.syncFromSettings();
  }

  async syncFromSettings(): Promise<void> {
    const settings = this.getSettings();
    // 内置服务
    if (settings.builtinMcpEnabled && !this.connections.has('builtin')) {
      await this.startBuiltin();
    } else if (!settings.builtinMcpEnabled && this.connections.has('builtin')) {
      await this.stop('builtin');
    }

    // 外部服务：移除已删除的，更新其余
    const configuredIds = new Set(settings.mcpServers.map((s) => s.id));
    for (const id of [...this.connections.keys()]) {
      if (id === 'builtin') continue;
      if (!configuredIds.has(id)) await this.stop(id);
    }
    for (const cfg of settings.mcpServers) {
      const existing = this.connections.get(cfg.id);
      const changed =
        existing &&
        (JSON.stringify(stripRuntime(existing.config)) !== JSON.stringify(stripRuntime(cfg)) || existing.config.enabled !== cfg.enabled);
      if (!existing) {
        if (cfg.enabled) await this.connectExternal(cfg);
        else this.connections.set(cfg.id, this.makeDisabled(cfg));
      } else if (changed) {
        await this.stop(cfg.id);
        if (cfg.enabled) await this.connectExternal(cfg);
        else this.connections.set(cfg.id, this.makeDisabled(cfg));
      }
    }
    this.notify();
  }

  private makeDisabled(cfg: McpServerConfig): Connection {
    return { config: cfg, client: null, status: 'disabled', tools: [] };
  }

  private async startBuiltin(): Promise<void> {
    const { server } = createBuiltinMidiServer(this.store, () => this.sessionId);
    const client = new Client({ name: 'supermidi-host', version: '0.1.0' });
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    await client.connect(clientT);
    const tools = await this.loadTools(client, 'midi');
    this.connections.set('builtin', {
      config: { id: 'builtin', name: 'midi', type: 'stdio', enabled: true },
      client,
      status: 'connected',
      tools,
      builtin: true,
    });
  }

  private async connectExternal(cfg: McpServerConfig): Promise<void> {
    const conn: Connection = { config: cfg, client: null, status: 'connecting', tools: [] };
    this.connections.set(cfg.id, conn);
    this.notify();
    try {
      const client = new Client({ name: 'SuperMidiAgent', version: '0.1.0' });
      let transport: Transport;
      if (cfg.type === 'stdio') {
        if (!cfg.command) throw new Error('缺少 command');
        transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args ?? [],
          env: { ...(cfg.env ?? {}) } as Record<string, string>,
          stderr: 'pipe',
        });
      } else {
        if (!cfg.url) throw new Error('缺少 url');
        transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: { headers: cfg.headers ?? {} },
        });
      }
      await client.connect(transport);
      conn.client = client;
      conn.status = 'connected';
      conn.tools = await this.loadTools(client, cfg.name);
    } catch (err) {
      conn.status = 'error';
      conn.error = err instanceof Error ? err.message : String(err);
    }
    this.notify();
  }

  private async loadTools(client: Client, serverName: string): Promise<McpToolInfo[]> {
    const { tools } = await client.listTools();
    const prefix = sanitizeName(serverName);
    return tools.map((t) => ({
      name: t.name,
      exposedName: serverName.toLowerCase() === 'midi' ? t.name : `${prefix}__${sanitizeName(t.name)}`,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? {},
    }));
  }

  async stop(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) return;
    try {
      await conn.client?.close();
    } catch {
      // ignore
    }
    this.connections.delete(id);
    this.notify();
  }

  async restart(id: string): Promise<void> {
    const settings = this.getSettings();
    if (id === 'builtin') {
      await this.stop(id);
      if (settings.builtinMcpEnabled) await this.startBuiltin();
    } else {
      const cfg = settings.mcpServers.find((s) => s.id === id);
      await this.stop(id);
      if (cfg?.enabled) await this.connectExternal(cfg);
    }
  }

  getStates(): McpServerState[] {
    const states: McpServerState[] = [];
    for (const conn of this.connections.values()) {
      states.push({
        id: conn.config.id,
        name: conn.config.name,
        type: conn.config.type,
        builtin: conn.builtin,
        enabled: conn.config.enabled,
        status: conn.status,
        error: conn.error,
        tools: conn.tools,
      });
    }
    // 未连接的禁用配置也要显示
    for (const cfg of this.getSettings().mcpServers) {
      if (!this.connections.has(cfg.id)) {
        states.push({
          id: cfg.id,
          name: cfg.name,
          type: cfg.type,
          enabled: cfg.enabled,
          status: 'disabled',
          tools: [],
        });
      }
    }
    return states;
  }

  getToolsForLlm(): ToolRef[] {
    const refs: ToolRef[] = [];
    for (const conn of this.connections.values()) {
      if (conn.status !== 'connected') continue;
      for (const tool of conn.tools) {
        refs.push({
          exposedName: tool.exposedName,
          serverId: conn.config.id,
          toolName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }
    return refs;
  }

  /** 调用工具：可传 exposedName 或原始工具名（先精确匹配 exposedName）。 */
  async callTool(exposedName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    for (const conn of this.connections.values()) {
      const tool = conn.tools.find((t) => t.exposedName === exposedName);
      if (tool && conn.client) {
        return this.doCall(conn, tool.name, args);
      }
    }
    // 回退：在所有连接中按原始名查找（外部模型可能去掉前缀）
    for (const conn of this.connections.values()) {
      const tool = conn.tools.find((t) => t.name === exposedName || t.exposedName === exposedName);
      if (tool && conn.client) {
        return this.doCall(conn, tool.name, args);
      }
    }
    return { text: JSON.stringify({ ok: false, error: `未知工具: ${exposedName}` }), isError: true };
  }

  private async doCall(conn: Connection, toolName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    try {
      const result = await conn.client!.callTool({ name: toolName, arguments: args });
      const parts = (result.content as { type: string; text?: string }[] | undefined) ?? [];
      const text = parts
        .map((p) => {
          if (p.type === 'text' && p.text) return p.text;
          return `[${p.type} 内容]`;
        })
        .join('\n');
      return { text, isError: result.isError === true };
    } catch (err) {
      return { text: `工具执行异常: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  async dispose(): Promise<void> {
    for (const id of [...this.connections.keys()]) {
      await this.stop(id);
    }
  }

  private notify(): void {
    this.onStateChange?.();
  }
}

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'server';
}

function stripRuntime(cfg: McpServerConfig): McpServerConfig {
  return {
    id: cfg.id,
    name: cfg.name,
    type: cfg.type,
    enabled: cfg.enabled,
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
    url: cfg.url,
    headers: cfg.headers,
  };
}
