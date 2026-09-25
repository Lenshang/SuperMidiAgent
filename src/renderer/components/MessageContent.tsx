/** 助手消息内容：思考过程 + 工具调用时间线 + Markdown 正文 + MIDI 卡片。 */
import { memo, useEffect, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Collapse, Tag } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, LoadingOutlined, ToolOutlined } from '@ant-design/icons';
import { DisplayMessage } from '../store';
import { useAppStore } from '../store';
import MidiCard from './MidiCard';

function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
        code: (props) => {
          const { className, children } = props;
          const isBlock = /language-/.test(className ?? '');
          if (isBlock) return <code className={className}>{children}</code>;
          return <code className="inline-code">{children}</code>;
        },
      }}>{text}</ReactMarkdown>
    </div>
  );
}

const MessageContent = memo(function MessageContent({ msg }: { msg: DisplayMessage }): JSX.Element {
  const assets = useAppStore((s) => s.assets);

  return (
    <div className="msg-content" data-status={msg.status}>
      {msg.role === 'assistant' && msg.reasoning && <ThinkingBlock msg={msg} />}

      {msg.toolCalls.length > 0 && (
        <div className="tool-timeline">
          {msg.toolCalls.map((tc) => (
            <div key={tc.toolCallId} className="tool-row" data-testid="tool-activity">
              <span className={`tool-icon tool-${tc.status}`}>
                {tc.status === 'running' ? <LoadingOutlined spin /> : tc.status === 'ok' ? <CheckCircleFilled style={{ color: '#52c41a' }} /> : <CloseCircleFilled style={{ color: '#ff4d4f' }} />}
              </span>
              <div className="tool-body">
                <div>
                  <Tag color="geekblue" style={{ marginInlineEnd: 6 }}><ToolOutlined /> {tc.toolName}</Tag>
                  <span className="tool-summary">{tc.summary ?? '执行中…'}</span>
                </div>
                <pre className="tool-args">{formatArgs(tc.argsJson)}</pre>
              </div>
            </div>
          ))}
        </div>
      )}

      {msg.content && <Markdown text={msg.content} />}

      {msg.status === 'streaming' && !msg.content && msg.toolCalls.length === 0 && (
        <span className="streaming-dot" aria-label="正在思考">●</span>
      )}

      {msg.status === 'error' && <div className="msg-error">⚠️ {msg.error ?? '出错了'}</div>}
      {msg.status === 'aborted' && <div className="msg-aborted">已停止生成</div>}

      {msg.midiIds.length > 0 && (
        <div className="msg-midis">
          {msg.midiIds.map((id) => (
            <MidiCard key={id} midiId={id} meta={assets[id]} />
          ))}
        </div>
      )}
    </div>
  );
});

/** 思考过程折叠块：流式时标签实时显示字数与最新内容预览；展开时自动滚动贴底。 */
function ThinkingBlock({ msg }: { msg: DisplayMessage }): JSX.Element {
  const streaming = msg.status === 'streaming';
  const chars = msg.reasoning?.length ?? 0;
  const preview = useMemo(() => {
    const tail = (msg.reasoning ?? '').slice(-64).replace(/\s+/g, ' ').trim();
    return tail.length > 56 ? `${tail.slice(-56)}…` : tail;
  }, [msg.reasoning]);

  return (
    <Collapse
      size="small"
      className="thinking-collapse"
      items={[
        {
          key: 'think',
          label: (
            <span className={`thinking-label ${streaming ? 'thinking-live' : ''}`} data-testid="thinking-label">
              {streaming ? <LoadingOutlined spin /> : <span className="thinking-emoji">💭</span>}
              <span className="thinking-title">{streaming ? '思考中' : '思考过程'}</span>
              <span className="thinking-count">{chars} 字</span>
              {streaming && preview && <span className="thinking-preview">{preview}</span>}
            </span>
          ),
          children: <ThinkingBody text={msg.reasoning ?? ''} />,
        },
      ]}
    />
  );
}

/** 思考正文：跟随流式输出滚动到底部；用户手动上滚时暂停跟随，滚回底部附近恢复。 */
function ThinkingBody({ text }: { text: string }): JSX.Element {
  const ref = useRef<HTMLPreElement | null>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <pre
      ref={ref}
      className="thinking-body"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
      }}
    >
      {text}
    </pre>
  );
}

function formatArgs(json: string): string {
  if (!json) return '';
  try {
    const obj = JSON.parse(json);
    return JSON.stringify(obj, null, 2).slice(0, 2000);
  } catch {
    return json.slice(0, 500);
  }
}

export default MessageContent;
