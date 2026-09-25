/**
 * OpenAI 兼容 Chat Completions 流式客户端。
 * - SSE 解析、tool_calls 增量拼接
 * - 支持 reasoning_content（MiniMax/DeepSeek 风格）与 <think> 标签回退
 */

export interface ChatMessageLike {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

export interface StreamChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessageLike[];
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  signal?: AbortSignal;
  stream?: boolean;
}

export interface AssembledToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface StreamHandlers {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onUsage?: (usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => void;
}

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: AssembledToolCall[];
  finishReason: string | null;
}

export class LlmError extends Error {
  constructor(message: string, readonly statusCode?: number, readonly providerCode?: unknown) {
    super(message);
  }
}

/** 流式 <think>…</think> 过滤器：把标签内文本路由到 reasoning。 */
export class ThinkFilter {
  private inside = false;
  private pending = '';

  feed(delta: string): { text: string; reasoning: string } {
    this.pending += delta;
    let text = '';
    let reasoning = '';
    let guard = 0;
    while (this.pending && guard++ < 128) {
      if (!this.inside) {
        const open = this.pending.indexOf('<think>');
        if (open >= 0) {
          text += this.pending.slice(0, open);
          this.pending = this.pending.slice(open + 7);
          this.inside = true;
          continue;
        }
        const hold = holdbackLength(this.pending, 7, '<think>');
        if (hold > 0) {
          text += this.pending.slice(0, this.pending.length - hold);
          this.pending = this.pending.slice(this.pending.length - hold);
        } else {
          text += this.pending;
          this.pending = '';
        }
        break;
      } else {
        const close = this.pending.indexOf('</think>');
        if (close >= 0) {
          reasoning += this.pending.slice(0, close);
          this.pending = this.pending.slice(close + 8);
          this.inside = false;
          continue;
        }
        const hold = holdbackLength(this.pending, 8, '</think>');
        if (hold > 0) {
          reasoning += this.pending.slice(0, this.pending.length - hold);
          this.pending = this.pending.slice(this.pending.length - hold);
        } else {
          reasoning += this.pending;
          this.pending = '';
        }
        break;
      }
    }
    return { text, reasoning };
  }

  flush(): { text: string; reasoning: string } {
    const rest = this.pending;
    this.pending = '';
    return this.inside ? { text: '', reasoning: rest } : { text: rest, reasoning: '' };
  }
}

/** pending 末尾最多 holdMax 字符若是 tag 的前缀，则返回需要保留的长度。 */
function holdbackLength(pending: string, holdMax: number, tag: string): number {
  const max = Math.min(pending.length, holdMax);
  for (let h = max; h > 0; h--) {
    if (tag.startsWith(pending.slice(pending.length - h))) return h;
  }
  return 0;
}

export async function streamChat(opts: StreamChatOptions, handlers: StreamHandlers): Promise<StreamResult> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: opts.stream !== false,
  };
  if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.topP !== undefined) body.top_p = opts.topP;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let code: unknown;
    try {
      const errJson = await res.json();
      message = errJson?.error?.message ?? errJson?.message ?? errJson?.base_resp?.status_msg ?? message;
      code = errJson?.error?.code ?? errJson?.base_resp?.status_code;
    } catch {
      // 保留默认 message
    }
    throw new LlmError(`模型请求失败: ${message}`, res.status, code);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('event-stream')) {
    // 某些兼容服务在出错时返回普通 JSON
    const json = await res.json().catch(() => null);
    const baseResp = json?.base_resp;
    if (baseResp && baseResp.status_code !== 0) {
      throw new LlmError(`模型服务错误: ${baseResp.status_msg ?? baseResp.status_code}`, 200, baseResp.status_code);
    }
    const choice = json?.choices?.[0];
    const content: string = choice?.message?.content ?? '';
    const reasoning: string = choice?.message?.reasoning_content ?? '';
    const filter = new ThinkFilter();
    const filtered = filter.feed(content);
    const flushed = filter.flush();
    handlers.onReasoning?.(reasoning + filtered.reasoning + flushed.reasoning);
    handlers.onText?.(filtered.text + flushed.text);
    if (json?.usage) handlers.onUsage?.(json.usage);
    return {
      content: filtered.text + flushed.text,
      reasoning: reasoning + filtered.reasoning + flushed.reasoning,
      toolCalls: (choice?.message?.tool_calls ?? []) as AssembledToolCall[],
      finishReason: choice?.finish_reason ?? null,
    };
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const filter = new ThinkFilter();
  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  const toolCalls = new Map<number, AssembledToolCall>();
  let buffer = '';

  const processSseChunk = (raw: string): void => {
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json?.error) {
        throw new LlmError(`模型流式错误: ${json.error.message ?? JSON.stringify(json.error)}`);
      }
      const baseResp = json?.base_resp;
      if (baseResp && baseResp.status_code !== 0) {
        throw new LlmError(`模型服务错误: ${baseResp.status_msg ?? baseResp.status_code}`, 200, baseResp.status_code);
      }
      const choice = json?.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        handlers.onReasoning?.(delta.reasoning_content);
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        const routed = filter.feed(delta.content);
        if (routed.reasoning) {
          reasoning += routed.reasoning;
          handlers.onReasoning?.(routed.reasoning);
        }
        if (routed.text) {
          content += routed.text;
          handlers.onText?.(routed.text);
        }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const existing = toolCalls.get(idx) ?? {
            id: '',
            type: 'function' as const,
            function: { name: '', arguments: '' },
          };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.function.name += tc.function.name;
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
          toolCalls.set(idx, existing);
        }
      }
      if (json?.usage) {
        handlers.onUsage?.(json.usage);
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = findBoundary(buffer)) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + boundaryLen(buffer, sep));
      if (raw.trim()) processSseChunk(raw);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) processSseChunk(buffer);

  const flushed = filter.flush();
  if (flushed.text) {
    content += flushed.text;
    handlers.onText?.(flushed.text);
  }
  if (flushed.reasoning) {
    reasoning += flushed.reasoning;
    handlers.onReasoning?.(flushed.reasoning);
  }

  const ordered = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return { content, reasoning, toolCalls: ordered, finishReason };
}

function findBoundary(buffer: string): number {
  const i = buffer.indexOf('\n\n');
  const j = buffer.indexOf('\r\n\r\n');
  if (i < 0 && j < 0) return -1;
  if (i < 0) return j;
  if (j < 0) return i;
  return Math.min(i, j);
}

function boundaryLen(buffer: string, sep: number): number {
  return buffer.startsWith('\r\n\r\n', sep) ? 4 : 2;
}
