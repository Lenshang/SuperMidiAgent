/** Electron 主进程入口。 */
import { app, BrowserWindow, ipcMain, dialog, nativeImage, shell } from 'electron';
import path from 'path';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { SettingsStore } from './settingsStore';
import { MidiStore } from './midiStore';
import { KnowledgeBase } from './knowledgeBase';
import { McpManager } from './mcpManager';
import { runAgent } from './agentService';
import { streamChat } from './openaiClient';
import { IPC, AgentEvent, McpServerConfig, ModelProfile } from '../shared/types';
import { extractTracksDoc } from '../shared/midi/ops';
import { writeMidi } from '../shared/midi/writer';
import { createDragIconPng } from './dragIcon';

/** 取 MIDI 的导出字节；trackIndex 非空时导出该单轨（保留速度轨）。 */
function exportBytesOf(id: string, trackIndex?: number): { bytes: Uint8Array; title: string } | null {
  const found = midiStore.get(id);
  if (!found) return null;
  if (typeof trackIndex !== 'number') return { bytes: found.bytes, title: found.meta.title };
  const doc = midiStore.getDoc(id);
  if (!doc) return null;
  const trackName = doc.tracks[trackIndex]?.name?.trim();
  const title = `${found.meta.title}-${trackName || `Track${trackIndex}`}`;
  return { bytes: writeMidi(extractTracksDoc(doc, [trackIndex])), title };
}

let mainWindow: BrowserWindow | null = null;
let settings: SettingsStore;
let midiStore: MidiStore;
let kb: KnowledgeBase;
let mcp: McpManager;
const runningAgents = new Map<string, AbortController>();
let dragIconPath: string | null = null;

const isDev = !!process.env.SUPERMIDI_DEV;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#141420',
    autoHideMenuBar: true,
    title: 'SuperMidiAgent',
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    await mainWindow.loadURL(process.env.SUPERMIDI_DEV_URL ?? 'http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(app.getAppPath(), 'dist/renderer/index.html'));
  }
}

function emitAgentEvent(event: AgentEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.agentEvent, event);
  }
}

function registerIpc(): void {
  const appVersion: string = app.getVersion();

  ipcMain.handle(IPC.appInfo, () => ({
    version: appVersion,
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
  }));

  // ---- 设置 ----
  ipcMain.handle(IPC.settingsGet, () => settings.get());
  ipcMain.handle(IPC.settingsSet, (_e, patch) => settings.update(patch));
  ipcMain.handle(IPC.settingsUpsertProfile, (_e, profile: Partial<ModelProfile>) => {
    settings.upsertProfile(profile as never);
    return settings.get();
  });
  ipcMain.handle(IPC.settingsRemoveProfile, (_e, id: string) => {
    settings.removeProfile(id);
    return settings.get();
  });
  ipcMain.handle(IPC.settingsTestProfile, async (_e, profile: Partial<ModelProfile>) => {
    try {
      const result = await streamChat(
        {
          baseUrl: profile.baseUrl ?? '',
          apiKey: profile.apiKey ?? '',
          model: profile.model ?? '',
          messages: [{ role: 'user', content: 'hi' }],
          maxTokens: 8,
          stream: false,
          temperature: 0,
        },
        {},
      );
      return { ok: true, reply: result.content.slice(0, 60) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ---- MCP ----
  ipcMain.handle(IPC.mcpList, () => mcp.getStates());
  ipcMain.handle(IPC.mcpAdd, async (_e, cfg: McpServerConfig) => {
    const data = settings.get();
    const withId = { ...cfg, id: cfg.id || randomUUID().slice(0, 8) };
    settings.update({ mcpServers: [...data.mcpServers.filter((s) => s.id !== withId.id), withId] });
    await mcp.syncFromSettings();
    return mcp.getStates();
  });
  ipcMain.handle(IPC.mcpRemove, async (_e, id: string) => {
    const data = settings.get();
    settings.update({ mcpServers: data.mcpServers.filter((s) => s.id !== id) });
    await mcp.syncFromSettings();
    return mcp.getStates();
  });
  ipcMain.handle(IPC.mcpSetEnabled, async (_e, { id, enabled }: { id: string; enabled: boolean }) => {
    if (id === 'builtin') {
      settings.update({ builtinMcpEnabled: enabled });
    } else {
      const data = settings.get();
      settings.update({
        mcpServers: data.mcpServers.map((s) => (s.id === id ? { ...s, enabled } : s)),
      });
    }
    await mcp.syncFromSettings();
    return mcp.getStates();
  });
  ipcMain.handle(IPC.mcpUpdate, async (_e, cfg: McpServerConfig) => {
    const data = settings.get();
    settings.update({ mcpServers: data.mcpServers.map((s) => (s.id === cfg.id ? cfg : s)) });
    await mcp.syncFromSettings();
    return mcp.getStates();
  });
  ipcMain.handle(IPC.mcpRestart, async (_e, id: string) => {
    await mcp.restart(id);
    return mcp.getStates();
  });

  // ---- 知识库 ----
  ipcMain.handle(IPC.kbStats, () => kb.getStats());
  ipcMain.handle(IPC.kbSearch, (_e, { query, topK }: { query: string; topK?: number }) => kb.search(query, topK ?? 4));
  ipcMain.handle(IPC.kbRemoveSource, async (_e, id: string) => {
    await kb.removeSource(id);
    return kb.getStats();
  });
  ipcMain.handle(IPC.kbSetSourceEnabled, async (_e, { id, enabled }: { id: string; enabled: boolean }) => {
    await kb.setSourceEnabled(id, enabled);
    return kb.getStats();
  });
  ipcMain.handle(IPC.kbRebuild, async () => {
    await kb.rebuild();
    return kb.getStats();
  });
  ipcMain.handle(IPC.dialogPickKbFiles, async () => {
    if (!mainWindow) return [];
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择知识文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文本与文档', extensions: ['txt', 'md', 'markdown', 'csv', 'json', 'log', 'lrc', 'srt', 'xml', 'html', 'pdf', 'yaml', 'yml', 'ts', 'js', 'py'] },
      ],
    });
    return res.canceled ? [] : res.filePaths;
  });
  ipcMain.handle(IPC.dialogPickKbFolder, async () => {
    if (!mainWindow) return [];
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择知识文件夹',
      properties: ['openDirectory'],
    });
    return res.canceled ? [] : res.filePaths;
  });
  ipcMain.handle(IPC.kbAddPaths, async (_e, paths: string[]) => {
    await kb.addPaths(paths);
    return kb.getStats();
  });

  // ---- MIDI ----
  ipcMain.handle(IPC.midiGet, (_e, id: string) => {
    const found = midiStore.get(id);
    if (!found) return null;
    const b64 = Buffer.from(found.bytes).toString('base64');
    return { meta: found.meta, base64: b64 };
  });
  ipcMain.handle(IPC.midiImportBytes, async (_e, { bytes, name, sessionId }: { bytes: ArrayBuffer; name: string; sessionId?: string }) => {
    const meta = await midiStore.importBytes(new Uint8Array(bytes), name.replace(/\.midi?$/i, ''), sessionId);
    return meta;
  });
  ipcMain.handle(IPC.midiImportDialog, async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '导入 MIDI 文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'MIDI 文件', extensions: ['mid', 'midi'] }],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const metas = [];
    for (const p of res.filePaths) {
      const bytes = new Uint8Array(await fs.readFile(p));
      metas.push(await midiStore.importBytes(bytes, path.basename(p, path.extname(p))));
    }
    return metas;
  });
  ipcMain.handle(IPC.midiSaveAs, async (_e, { id, suggestedName, trackIndex }: { id: string; suggestedName?: string; trackIndex?: number }) => {
    const exp = exportBytesOf(id, trackIndex);
    if (!exp || !mainWindow) return { ok: false, error: '找不到 MIDI 或窗口未就绪' };
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '保存 MIDI',
      defaultPath: `${(suggestedName ?? exp.title).replace(/[\\/:*?"<>|]/g, '_')}.mid`,
      filters: [{ name: 'MIDI 文件', extensions: ['mid'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    await fs.writeFile(res.filePath, exp.bytes);
    return { ok: true, path: res.filePath };
  });
  ipcMain.handle(IPC.midiQuickDownload, async (_e, { id, suggestedName, trackIndex }: { id: string; suggestedName?: string; trackIndex?: number }) => {
    const exp = exportBytesOf(id, trackIndex);
    if (!exp) return { ok: false, error: '找不到 MIDI' };
    const dir = app.getPath('downloads');
    const safe = (suggestedName ?? exp.title).replace(/[\\/:*?"<>|]/g, '_');
    const target = path.join(dir, `${safe}.mid`);
    let finalPath = target;
    let n = 1;
    while (true) {
      try {
        await fs.access(finalPath);
        finalPath = path.join(dir, `${safe}(${n++}).mid`);
      } catch {
        break;
      }
    }
    await fs.writeFile(finalPath, exp.bytes);
    return { ok: true, path: finalPath };
  });
  ipcMain.handle(IPC.midiDrag, async (event, { id, suggestedName, trackIndex }: { id: string; suggestedName?: string; trackIndex?: number }) => {
    const exp = exportBytesOf(id, trackIndex);
    if (!exp || !dragIconPath) return { ok: false };
    const tmpDir = path.join(app.getPath('userData'), 'tmp');
    await fs.mkdir(tmpDir, { recursive: true });
    const safe = (suggestedName ?? exp.title).replace(/[\\/:*?"<>|]/g, '_');
    const filePath = path.join(tmpDir, `${safe}.mid`);
    await fs.writeFile(filePath, exp.bytes);
    // startDrag 会进入原生拖拽循环，先返回 IPC 结果再启动，避免阻塞渲染进程
    const sender = event.sender;
    const icon = nativeImage.createFromPath(dragIconPath);
    if (process.env.SUPERMIDI_MOCK_DRAG === '1') {
      // 自动化测试模式：跳过原生拖拽（无真实手势时会阻塞主进程），仅验证参数
      console.log(`[main] mock startDrag: file=${filePath}`);
      return { ok: true, mocked: true, file: filePath };
    }
    setTimeout(() => {
      if (sender.isDestroyed()) return;
      try {
        sender.startDrag({ file: filePath, icon });
      } catch (err) {
        console.error('[main] startDrag failed:', err);
      }
    }, 30);
    return { ok: true };
  });

  // ---- Agent ----
  ipcMain.handle(IPC.agentRun, async (_e, req: { runId: string; sessionId: string; messages: unknown[]; profileId?: string; kbEnabled: boolean }) => {
    const data = settings.get();
    const profile = data.profiles.find((p) => p.id === (req.profileId ?? data.activeProfileId)) ?? data.profiles[0];
    if (!profile) {
      emitAgentEvent({ type: 'error', runId: req.runId, message: '尚未配置模型服务，请先在设置中添加模型配置' });
      return { started: false, error: 'no-profile' };
    }
    const controller = new AbortController();
    runningAgents.set(req.runId, controller);
    mcp.setSessionId(req.sessionId);
    void runAgent(
      {
        runId: req.runId,
        sessionId: req.sessionId,
        messages: req.messages as never,
        profile,
        kbEnabled: req.kbEnabled,
        maxIterations: data.agentMaxIterations,
        emit: emitAgentEvent,
        signal: controller.signal,
      },
      { mcp, kb, midiStore },
    ).finally(() => runningAgents.delete(req.runId));
    return { started: true };
  });
  ipcMain.handle(IPC.agentAbort, (_e, runId: string) => {
    runningAgents.get(runId)?.abort();
    return { ok: true };
  });
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  settings = new SettingsStore(path.join(userData, 'settings.json'));
  midiStore = new MidiStore(path.join(userData, 'midi'));
  kb = new KnowledgeBase(path.join(userData, 'kb'));
  await Promise.all([settings.init(), midiStore.init(), kb.init()]);
  mcp = new McpManager(midiStore, () => ({
    builtinMcpEnabled: settings.get().builtinMcpEnabled,
    mcpServers: settings.get().mcpServers,
  }));
  mcp.onStateChange = () => {
    // 状态变化广播
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mcp:states', mcp.getStates());
    }
  };
  await mcp.init();

  // 生成拖拽图标
  const iconPath = path.join(userData, 'drag-icon.png');
  try {
    await fs.access(iconPath);
  } catch {
    await fs.writeFile(iconPath, createDragIconPng());
  }
  dragIconPath = iconPath;

  registerIpc();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void settings.flush();
  void mcp?.dispose();
});

// 全局兜底：未捕获异常写入日志，避免静默崩溃
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[main] unhandledRejection:', err);
});
