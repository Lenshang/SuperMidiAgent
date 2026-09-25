/** 聊天主面板：AntDX Bubble.List + Sender，全局 MIDI 拖放上传。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bubble, Prompts, Sender, Welcome } from '@ant-design/x';
import { App, Button, Space, Switch, Tooltip, Typography } from 'antd';
import {
  RobotOutlined, UserOutlined, PlusOutlined, PaperClipOutlined, SoundOutlined, ThunderboltFilled, SlidersOutlined,
} from '@ant-design/icons';
import { useAppStore, ensureAssistantMessage, wireBuilder } from '../store';
import MessageContent from './MessageContent';
import MidiCard from './MidiCard';
import { Avatar } from 'antd';

const AI_AVATAR = <Avatar icon={<RobotOutlined />} style={{ background: 'linear-gradient(135deg,#7c5cff,#00c2a8)', flexShrink: 0 }} />;
const USER_AVATAR = <Avatar icon={<UserOutlined />} style={{ background: '#2e3a59', flexShrink: 0 }} />;

function genId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

const PROMPTS = [
  { key: 'p1', icon: <ThunderboltFilled style={{ color: '#7c5cff' }} />, label: '生成一段 C 大调旋律', description: '8 小节钢琴独奏，有乐句起伏' },
  { key: 'p2', icon: <ThunderboltFilled style={{ color: '#00c2a8' }} />, label: '创作一个和弦进行', description: 'C-Am-F-G 伴奏 + 旋律声部' },
  { key: 'p3', icon: <ThunderboltFilled style={{ color: '#ff7a59' }} />, label: '上传 MIDI 并分析', description: '拖入 .mid 文件，我来分析和弦与调性' },
  { key: 'p4', icon: <ThunderboltFilled style={{ color: '#f5b940' }} />, label: '增加真实演奏感', description: '为旋律添加真实力度与 CC11 表情' },
];

export default function ChatPanel(): JSX.Element {
  const { message: antdMessage } = App.useApp();
  const sessions = useAppStore((s) => s.sessions);
  const activeId = useAppStore((s) => s.activeSessionId);
  const runningRunId = useAppStore((s) => s.runningRunId);
  const draft = useAppStore((s) => s.draft[activeId] ?? '');
  const kbEnabled = useAppStore((s) => s.kbEnabled);
  const assets = useAppStore((s) => s.assets);

  const session = sessions.find((s) => s.id === activeId);
  const [dragOver, setDragOver] = useState(false);
  const [pending, setPending] = useState<string[]>([]); // 待发送的 MIDI 附件
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounter = useRef(0);
  const assetsRef = useRef(assets);
  assetsRef.current = assets;

  // 切换会话时清空未发送的附件
  useEffect(() => {
    setPending([]);
  }, [activeId]);

  /** 导入 MIDI 文件并添加为待发送附件（不自动发送）。 */
  const importMidiFiles = useCallback(
    async (files: File[]): Promise<void> => {
      const added: string[] = [];
      for (const file of files) {
        try {
          const buf = await file.arrayBuffer();
          const meta = (await window.api.midiImportBytes(buf, file.name.replace(/\.midi?$/i, ''))) as { id: string; title: string };
          useAppStore.getState().registerAssets([meta as never]);
          added.push(meta.id);
        } catch (err) {
          antdMessage.error(`导入「${file.name}」失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 140));
        }
      }
      if (added.length === 0) return;
      setPending((p) => [...p, ...added.filter((id) => !p.includes(id))]);
      antdMessage.success(`已添加 ${added.length} 个 MIDI 附件，输入说明后按 Enter 发送`);
    },
    [antdMessage],
  );

  const send = useCallback(
    async (text: string, midiIds: string[] = []) => {
      const trimmed = text.trim();
      if (!trimmed && midiIds.length === 0) return;
      const st = useAppStore.getState();
      const sessionId = st.activeSessionId;
      if (st.runningRunId) {
        antdMessage.warning('请等待当前回复完成，或先停止');
        return;
      }
      let fullText = trimmed;
      if (midiIds.length > 0) {
        const parts = midiIds.map((id, i) => `[上传了 MIDI 文件「${st.assets[id]?.title ?? `MIDI${i + 1}`}」，midiId=${id}]`);
        const refs = parts.join('\n');
        fullText = trimmed
          ? `${trimmed}\n\n${refs}`
          : `（用户刚上传了 MIDI 附件，还没有说明需求）请先简要分析这个 MIDI 的调性、和弦、力度与结构，然后询问用户想做什么调整，不要直接修改。\n\n${refs}`;
      }
      st.appendUserMessage(sessionId, fullText, midiIds);
      st.setDraft(sessionId, '');
      setPending((p) => p.filter((id) => !midiIds.includes(id)));

      const runId = genId();
      wireBuilder.start(runId);
      ensureAssistantMessage(sessionId, runId);
      st.setRunningRunId(runId);

      const sessionWire = useAppStore.getState().sessions.find((s) => s.id === sessionId)?.wire ?? [];
      await window.api.agentRun({
        runId,
        sessionId,
        messages: sessionWire,
        kbEnabled: st.kbEnabled,
      });
    },
    [antdMessage],
  );

  // Agent 事件订阅
  useEffect(() => {
    const off = window.api.onAgentEvent((event) => {
      const st = useAppStore.getState();
      const sid = st.activeSessionId;
      st.applyAgentEvent(sid, event);
    });
    return off;
  }, []);

  // 拖放上传：只添加为附件，不自动发送
  useEffect(() => {
    const onDragOver = (e: Event): void => {
      e.preventDefault();
    };
    const onDrop = (e: Event): void => {
      e.preventDefault();
      setDragOver(false);
      dragCounter.current = 0;
      const de = e as DragEvent;
      const files = Array.from(de.dataTransfer?.files ?? []).filter((f) => /\.midi?$/i.test(f.name));
      if (files.length === 0) return;
      void importMidiFiles(files);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [importMidiFiles]);

  const onPickFile = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    await importMidiFiles(Array.from(files));
  };

  const stopRun = (): void => {
    if (runningRunId) void window.api.agentAbort(runningRunId);
  };

  if (!session) return <div />;

  const isEmpty = session.messages.length === 0;

  const bubbleItems = session.messages.map((m) => ({
    key: m.id,
    role: m.role === 'user' ? 'user' : 'ai',
    content: m.role === 'user' ? (
      <div className="user-bubble" data-testid="user-message">
        {m.content}
        {m.midiIds.length > 0 && (
          <div className="user-midis">
            {m.midiIds.map((id) => (
              <MidiCardInline key={id} midiId={id} />
            ))}
          </div>
        )}
      </div>
    ) : (
      <MessageContent msg={m} />
    ),
    placement: m.role === 'user' ? ('end' as const) : ('start' as const),
    avatar: m.role === 'user' ? USER_AVATAR : AI_AVATAR,
    variant: m.role === 'user' ? ('filled' as const) : ('shadow' as const),
    loading: m.role === 'assistant' && m.status === 'streaming' && !m.content && m.toolCalls.length === 0 && !(m.reasoning?.length),
  }));

  return (
    <div
      className="chat-panel"
      data-running={runningRunId ? 'true' : 'false'}
      onDragEnter={() => { dragCounter.current++; setDragOver(true); }}
      onDragLeave={() => { dragCounter.current--; if (dragCounter.current <= 0) setDragOver(false); }}
      data-testid="chat-panel"
    >
      {dragOver && (
        <div className="drop-mask">
          <div className="drop-mask-inner">松开鼠标，把 MIDI 添加为附件（发送前可继续输入说明）</div>
        </div>
      )}

      {isEmpty ? (
        <div className="welcome-wrap">
          <Welcome
            variant="borderless"
            icon={<RobotOutlined style={{ fontSize: 34, color: '#fff' }} />}
            title="SuperMidiAgent"
            description="AI MIDI 创作助手 · 生成旋律 / 分析与修改 MIDI / 添加真实力度与表情 / 知识库问答"
            style={{ margin: '48px 0 24px' }}
          />
          <Prompts
            wrap
            items={PROMPTS}
            onItemClick={({ data }) => useAppStore.getState().setDraft(activeId, String(data.label ?? ''))}
            style={{ width: '100%' }}
          />
        </div>
      ) : (
        <div className="bubble-wrap">
          <Bubble.List
            autoScroll
            items={bubbleItems}
            role={{
              ai: { placement: 'start', variant: 'shadow', avatar: AI_AVATAR },
              user: { placement: 'end', variant: 'filled', avatar: USER_AVATAR },
            }}
            style={{ height: '100%', paddingInline: 18 }}
          />
        </div>
      )}

      <div className="sender-area">
        <div className="sender-toolbar">
          <Space size={12}>
            <Tooltip title="导入 MIDI 文件">
              <Button size="small" icon={<PaperClipOutlined />} onClick={() => fileInputRef.current?.click()} data-testid="import-midi">导入 MIDI</Button>
            </Tooltip>
            <input
              ref={fileInputRef}
              type="file"
              accept=".mid,.midi"
              multiple
              hidden
              data-testid="midi-file-input"
              onChange={(e) => {
                void onPickFile(e.target.files);
                e.target.value = '';
              }}
            />
            <Tooltip title="打开合成器，捏一个自己的音色">
              <Button size="small" icon={<SlidersOutlined />} onClick={() => useAppStore.getState().setSynthOpen(true)} data-testid="open-synth">音色</Button>
            </Tooltip>
            <Tooltip title="开启后自动检索知识库">
              <Space size={6}>
                <SoundOutlined style={{ color: kbEnabled ? '#7c5cff' : undefined }} />
                <span className="toolbar-label">知识库</span>
                <Switch size="small" checked={kbEnabled} onChange={(v) => useAppStore.getState().setKbEnabled(v)} data-testid="kb-switch" />
              </Space>
            </Tooltip>
            <Typography.Text type="secondary" className="toolbar-hint">
              也可以把 .mid 文件拖进窗口作为附件
            </Typography.Text>
          </Space>
        </div>
        {pending.length > 0 && (
          <div className="pending-attachments" data-testid="pending-attachments">
            {pending.map((id) => (
              <span key={id} className="pending-chip">
                <span className="pending-icon">♪</span>
                <span className="pending-name">{assets[id]?.title ?? id}</span>
                <button
                  className="pending-remove"
                  aria-label="移除附件"
                  title="移除附件"
                  onClick={() => setPending((p) => p.filter((x) => x !== id))}
                >
                  ×
                </button>
              </span>
            ))}
            <span className="pending-hint">输入说明（可留空）后按 Enter 发送</span>
          </div>
        )}
        <Sender
          value={draft}
          onChange={(v) => useAppStore.getState().setDraft(activeId, v)}
          onSubmit={(text) => void send(text, pending)}
          onCancel={stopRun}
          loading={!!runningRunId}
          placeholder="描述你想要的 MIDI 音乐，或先上传 MIDI 附件再说明需求…（Enter 发送，Shift+Enter 换行）"
          data-testid="sender-input"
        />
      </div>
    </div>
  );
}

/** 用户消息里的内联 MIDI 预览（精简版）。 */
function MidiCardInline({ midiId }: { midiId: string }): JSX.Element {
  return <MidiCard midiId={midiId} />;
}
