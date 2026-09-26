/** 渲染进程全局状态（zustand）+ Agent 事件到会话/线级消息的应用。 */
import { create } from 'zustand';
import { AgentEvent, WireMessage, MidiAssetMeta } from '@shared/types';
import { SynthSettings, DEFAULT_SYNTH } from './audio/synthEngine';
import { DEFAULT_THEME_ID, isThemeId, ThemeId } from './theme';

export interface ToolActivity {
  toolCallId: string;
  toolName: string;
  argsJson: string;
  status: 'running' | 'ok' | 'error';
  summary?: string;
  midiIds: string[];
}

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  toolCalls: ToolActivity[];
  midiIds: string[];
  status: 'streaming' | 'done' | 'error' | 'aborted';
  error?: string;
  createTime: number;
}

export interface Session {
  id: string;
  title: string;
  createTime: number;
  messages: DisplayMessage[];
  wire: WireMessage[];
}

interface AppState {
  sessions: Session[];
  activeSessionId: string;
  runningRunId: string | null;
  draft: Record<string, string>;
  settingsOpen: boolean;
  kbEnabled: boolean;
  assets: Record<string, MidiAssetMeta>;
  synth: SynthSettings;
  synthEnabled: boolean;
  synthOpen: boolean;
  playVolume: number;
  themeId: ThemeId;

  newSession: () => string;
  removeSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  setActiveSession: (id: string) => void;
  setDraft: (sessionId: string, text: string) => void;
  appendDraft: (sessionId: string, text: string) => void;
  setSettingsOpen: (open: boolean) => void;
  setKbEnabled: (v: boolean) => void;
  setRunningRunId: (id: string | null) => void;
  registerAssets: (assets: MidiAssetMeta[]) => void;
  setSynth: (s: SynthSettings) => void;
  setSynthEnabled: (v: boolean) => void;
  setSynthOpen: (v: boolean) => void;
  setPlayVolume: (v: number) => void;
  setTheme: (id: ThemeId) => void;

  appendUserMessage: (sessionId: string, text: string, midiIds: string[]) => void;
  applyAgentEvent: (sessionId: string, event: AgentEvent) => void;
}

const SESSION_KEY = 'supermidi.sessions.v1';
const KB_KEY = 'supermidi.kbEnabled';
const SYNTH_KEY = 'supermidi.synth.v1';
const SYNTH_ENABLED_KEY = 'supermidi.synthEnabled';
const PLAY_VOLUME_KEY = 'supermidi.playVolume';
const THEME_KEY = 'supermidi.theme.v1';

function loadThemeId(): ThemeId {
  const v = localStorage.getItem(THEME_KEY);
  return isThemeId(v) ? v : DEFAULT_THEME_ID;
}

function loadSynth(): SynthSettings {
  try {
    const raw = localStorage.getItem(SYNTH_KEY);
    if (raw) return { ...DEFAULT_SYNTH, ...(JSON.parse(raw) as SynthSettings) };
  } catch {
    // ignore
  }
  return DEFAULT_SYNTH;
}

function loadPlayVolume(): number {
  const v = Number(localStorage.getItem(PLAY_VOLUME_KEY));
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.85;
}

function genId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function makeSession(): Session {
  return { id: genId(), title: '新对话', createTime: Date.now(), messages: [], wire: [] };
}

function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Session[];
      for (const s of parsed) {
        for (const m of s.messages) {
          if (m.status === 'streaming') m.status = 'aborted';
          for (const tc of m.toolCalls ?? []) {
            if (tc.status === 'running') tc.status = 'error';
          }
        }
      }
      return parsed;
    }
  } catch {
    // ignore
  }
  return [];
}

function persistSessions(sessions: Session[]): void {
  try {
    const trimmed = sessions.slice(-40).map((s) => ({ ...s, messages: s.messages.slice(-60) }));
    localStorage.setItem(SESSION_KEY, JSON.stringify(trimmed));
  } catch {
    // 存储满时忽略
  }
}

function updateSession(sessions: Session[], sessionId: string, fn: (s: Session) => Session): Session[] {
  return sessions.map((s) => (s.id === sessionId ? fn(s) : s));
}

// ---------- wire 构建：按 run/迭代分段 ----------

interface WireSegment {
  text: string;
  toolCalls: { id: string; name: string; args: string }[];
  toolResults: { id: string; content: string }[];
}

class WireBuilder {
  private segments = new Map<string, WireSegment[]>();

  start(runId: string): void {
    this.segments.set(runId, [{ text: '', toolCalls: [], toolResults: [] }]);
  }

  apply(runId: string, event: AgentEvent): void {
    const segs = this.segments.get(runId);
    if (!segs) return;
    const seg = segs[segs.length - 1];
    switch (event.type) {
      case 'text_delta':
        seg.text += event.delta;
        break;
      case 'iteration':
        segs.push({ text: '', toolCalls: [], toolResults: [] });
        break;
      case 'tool_start':
        seg.toolCalls.push({ id: event.toolCallId, name: event.toolName, args: event.argsJson });
        break;
      case 'tool_end':
        seg.toolResults.push({ id: event.toolCallId, content: event.resultPreview });
        break;
      default:
        break;
    }
  }

  /** 运行结束后把整段对话写回 wire。 */
  flush(runId: string): WireMessage[] {
    const segs = this.segments.get(runId) ?? [];
    this.segments.delete(runId);
    const out: WireMessage[] = [];
    for (const seg of segs) {
      if (seg.toolCalls.length > 0) {
        out.push({
          role: 'assistant',
          content: seg.text || null,
          tool_calls: seg.toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.args } })),
        });
        for (const tc of seg.toolCalls) {
          const result = seg.toolResults.find((r) => r.id === tc.id);
          out.push({ role: 'tool', tool_call_id: tc.id, content: result?.content ?? '{"ok":false,"error":"no result"}' });
        }
      } else if (seg.text) {
        out.push({ role: 'assistant', content: seg.text });
      }
    }
    return out;
  }

  abandon(runId: string): void {
    this.segments.delete(runId);
  }
}

export const wireBuilder = new WireBuilder();

// ---------- store ----------

let persistTimer: ReturnType<typeof setTimeout> | null = null;

export const useAppStore = create<AppState>((set, get) => ({
  sessions: [],
  activeSessionId: '',
  runningRunId: null,
  draft: {},
  settingsOpen: false,
  kbEnabled: localStorage.getItem(KB_KEY) === '1',
  assets: {},
  synth: loadSynth(),
  synthEnabled: localStorage.getItem(SYNTH_ENABLED_KEY) === '1',
  synthOpen: false,
  playVolume: loadPlayVolume(),
  themeId: loadThemeId(),

  newSession: () => {
    const s = makeSession();
    set((st) => ({ sessions: [s, ...st.sessions], activeSessionId: s.id }));
    return s.id;
  },

  removeSession: (id) => {
    set((st) => {
      const sessions = st.sessions.filter((s) => s.id !== id);
      if (sessions.length === 0) {
        const s = makeSession();
        return { sessions: [s], activeSessionId: s.id };
      }
      return { sessions, activeSessionId: st.activeSessionId === id ? sessions[0].id : st.activeSessionId };
    });
  },

  renameSession: (id, title) => {
    set((st) => ({ sessions: updateSession(st.sessions, id, (s) => ({ ...s, title })) }));
  },

  setActiveSession: (id) => set({ activeSessionId: id }),

  setDraft: (sessionId, text) => set((st) => ({ draft: { ...st.draft, [sessionId]: text } })),

  appendDraft: (sessionId, text) =>
    set((st) => ({ draft: { ...st.draft, [sessionId]: (st.draft[sessionId] ?? '') + text } })),

  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setKbEnabled: (v) => {
    localStorage.setItem(KB_KEY, v ? '1' : '0');
    set({ kbEnabled: v });
  },
  setRunningRunId: (id) => set({ runningRunId: id }),
  setTheme: (id) => {
    localStorage.setItem(THEME_KEY, id);
    set({ themeId: id });
  },
  registerAssets: (assets) =>
    set((st) => {
      const next = { ...st.assets };
      for (const a of assets) next[a.id] = a;
      return { assets: next };
    }),

  setSynth: (s) => {
    try {
      localStorage.setItem(SYNTH_KEY, JSON.stringify(s));
    } catch {
      // ignore
    }
    set({ synth: s });
  },
  setSynthEnabled: (v) => {
    localStorage.setItem(SYNTH_ENABLED_KEY, v ? '1' : '0');
    set({ synthEnabled: v });
  },
  setSynthOpen: (v) => set({ synthOpen: v }),
  setPlayVolume: (v) => {
    localStorage.setItem(PLAY_VOLUME_KEY, String(v));
    set({ playVolume: v });
  },

  appendUserMessage: (sessionId, text, midiIds) => {
    const msg: DisplayMessage = {
      id: genId(),
      role: 'user',
      content: text,
      toolCalls: [],
      midiIds,
      status: 'done',
      createTime: Date.now(),
    };
    set((st) => ({
      sessions: updateSession(st.sessions, sessionId, (s) => ({
        ...s,
        title: s.messages.length === 0 ? text.slice(0, 24).replace(/\s+/g, ' ').trim() || '新对话' : s.title,
        messages: [...s.messages, msg],
        wire: [...s.wire, { role: 'user', content: text }],
      })),
    }));
    void get;
  },

  applyAgentEvent: (sessionId, event) => {
    wireBuilder.apply(event.runId, event);
    if (event.type === 'tool_end' && event.midiAssets.length > 0) {
      get().registerAssets(event.midiAssets);
    }

    if (event.type === 'done' || event.type === 'error') {
      const flushed = wireBuilder.flush(event.runId);
      set((st) => ({
        runningRunId: st.runningRunId === event.runId ? null : st.runningRunId,
        sessions: updateSession(st.sessions, sessionId, (s) => {
          const messages = s.messages.map((m) => {
            if (m.id !== `assistant-${event.runId}`) return m;
            if (event.type === 'error') return { ...m, status: 'error' as const, error: event.message };
            return { ...m, status: event.finishReason === 'aborted' ? ('aborted' as const) : ('done' as const) };
          });
          return { ...s, messages, wire: [...s.wire, ...flushed] };
        }),
      }));
      return;
    }

    set((st) => ({
      sessions: updateSession(st.sessions, sessionId, (s) => {
        const assistantId = `assistant-${event.runId}`;
        let touched = false;
        const messages = s.messages.map((m) => {
          if (m.id !== assistantId) return m;
          touched = true;
          const msg: DisplayMessage = { ...m, toolCalls: [...m.toolCalls] };
          switch (event.type) {
            case 'text_delta':
              msg.content += event.delta;
              break;
            case 'reasoning_delta':
              msg.reasoning = (msg.reasoning ?? '') + event.delta;
              break;
            case 'tool_start':
              msg.toolCalls = [
                ...msg.toolCalls,
                { toolCallId: event.toolCallId, toolName: event.toolName, argsJson: event.argsJson, status: 'running' as const, midiIds: [] },
              ];
              break;
            case 'tool_end':
              msg.toolCalls = msg.toolCalls.map((tc) =>
                tc.toolCallId === event.toolCallId
                  ? { ...tc, status: event.ok ? ('ok' as const) : ('error' as const), summary: event.summary, midiIds: event.midiAssets.map((a) => a.id) }
                  : tc,
              );
              if (event.midiAssets.length > 0) {
                msg.midiIds = [...msg.midiIds, ...event.midiAssets.map((a) => a.id).filter((id) => !msg.midiIds.includes(id))];
              }
              break;
            default:
              break;
          }
          return msg;
        });
        if (!touched) return s;
        return { ...s, messages };
      }),
    }));
  },
}));

export function initStore(): void {
  const sessions = loadSessions();
  if (sessions.length === 0) {
    const s = makeSession();
    useAppStore.setState({ sessions: [s], activeSessionId: s.id });
  } else {
    useAppStore.setState({ sessions, activeSessionId: sessions[0].id });
  }
}

export function ensureAssistantMessage(sessionId: string, runId: string): void {
  useAppStore.setState((st) => ({
    sessions: updateSession(st.sessions, sessionId, (s) => {
      if (s.messages.some((m) => m.id === `assistant-${runId}`)) return s;
      const msg: DisplayMessage = {
        id: `assistant-${runId}`,
        role: 'assistant',
        content: '',
        toolCalls: [],
        midiIds: [],
        status: 'streaming',
        createTime: Date.now(),
      };
      return { ...s, messages: [...s.messages, msg] };
    }),
  }));
}

/** 触发持久化（在会话结构变化后调用）。 */
export function schedulePersist(getSessions: () => Session[]): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persistSessions(getSessions()), 500);
}

useAppStore.subscribe((state) => schedulePersist(() => state.sessions));
