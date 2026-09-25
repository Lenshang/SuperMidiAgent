import { describe, expect, it, vi } from 'vitest';
import { streamChat, ThinkFilter, LlmError, StreamHandlers } from '../src/main/openaiClient';

/** 构造 mock fetch：把给定的 SSE 文本按块返回。 */
function mockFetch(sseChunks: unknown, opts?: { status?: number; contentType?: string }) {
  const encoder = new TextEncoder();
  return vi.fn().mockImplementation(async () => {
    if (sseChunks instanceof Error) throw sseChunks;
    const chunks = sseChunks as string[];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, {
      status: opts?.status ?? 200,
      headers: { 'content-type': opts?.contentType ?? 'text/event-stream' },
    });
  });
}

function sse(events: object[]): string[] {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
}

const baseOpts = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('ThinkFilter', () => {
  it('无标签直接通过', () => {
    const f = new ThinkFilter();
    expect(f.feed('你好')).toEqual({ text: '你好', reasoning: '' });
    expect(f.flush()).toEqual({ text: '', reasoning: '' });
  });

  it('完整标签路由到 reasoning', () => {
    const f = new ThinkFilter();
    const r1 = f.feed('<think>思考中</think>答案');
    expect(r1.reasoning).toBe('思考中');
    expect(r1.text).toBe('答案');
  });

  it('标签跨 chunk 截断', () => {
    const f = new ThinkFilter();
    const r1 = f.feed('开头<thi');
    expect(r1.text).toBe('开头');
    const r2 = f.feed('nk>内部推理');
    expect(r2.reasoning).toBe('内部推理');
    const r3 = f.feed('</th');
    expect(r3).toEqual({ text: '', reasoning: '' });
    const r4 = f.feed('ink>结论');
    expect(r4.text).toBe('结论');
  });

  it('feed 直接输出未闭合标签内容，flush 冲刷空', () => {
    const f = new ThinkFilter();
    const r = f.feed('<think>未闭合');
    expect(r.reasoning).toBe('未闭合');
    expect(f.flush()).toEqual({ text: '', reasoning: '' });
  });

  it('feed 输出普通文本，flush 冲刷空', () => {
    const f = new ThinkFilter();
    expect(f.feed('abc').text).toBe('abc');
    expect(f.flush().text).toBe('');
  });
});

describe('streamChat', () => {
  it('解析文本增量与结束', async () => {
    global.fetch = mockFetch(sse([
      { choices: [{ delta: { content: '你好' } }] },
      { choices: [{ delta: { content: '，世界' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [] },
    ]) as unknown as typeof fetch);
    const onText = vi.fn();
    const result = await streamChat(baseOpts, { onText });
    expect(result.content).toBe('你好，世界');
    expect(result.finishReason).toBe('stop');
    expect(onText).toHaveBeenCalledTimes(2);
  });

  it('拼接分片到达的 tool_calls', async () => {
    global.fetch = mockFetch(sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'create_midi', arguments: '{"ti' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tle":"歌"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'list_midis', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]) as unknown as typeof fetch);
    const result = await streamChat(baseOpts, {});
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]).toEqual({ id: 'call_1', type: 'function', function: { name: 'create_midi', arguments: '{"title":"歌"}' } });
    expect(result.finishReason).toBe('tool_calls');
  });

  it('解析 reasoning_content', async () => {
    global.fetch = mockFetch(sse([
      { choices: [{ delta: { reasoning_content: '先想一想' } }] },
      { choices: [{ delta: { content: '结果' } }] },
    ]) as unknown as typeof fetch);
    const onReasoning = vi.fn();
    const result = await streamChat(baseOpts, { onReasoning });
    expect(result.reasoning).toBe('先想一想');
    expect(result.content).toBe('结果');
  });

  it('内联 <think> 标签路由', async () => {
    global.fetch = mockFetch(sse([
      { choices: [{ delta: { content: '<think>推</think>答' } }] },
    ]) as unknown as typeof fetch);
    const result = await streamChat(baseOpts, {});
    expect(result.reasoning).toBe('推');
    expect(result.content).toBe('答');
  });

  it('HTTP 错误抛出 LlmError', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    await expect(streamChat(baseOpts, {})).rejects.toThrow(LlmError);
  });

  it('MiniMax base_resp 错误（HTTP 200 + JSON）', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'invalid api key' } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(streamChat(baseOpts, {})).rejects.toThrow(/invalid api key/);
  });

  it('流中 base_resp 错误', async () => {
    global.fetch = mockFetch(sse([{ base_resp: { status_code: 1027, status_msg: 'out of quota' } }]) as unknown as typeof fetch);
    await expect(streamChat(baseOpts, {})).rejects.toThrow(/out of quota/);
  });

  it('非流式 JSON 回退（含 message.content）', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '完整回复' }, finish_reason: 'stop' }],
      usage: { total_tokens: 42 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const onUsage = vi.fn();
    const result = await streamChat(baseOpts, { onUsage });
    expect(result.content).toBe('完整回复');
    expect(result.toolCalls).toHaveLength(0);
    expect(onUsage).toHaveBeenCalled();
  });

  it('请求体包含 tools 与温度', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await streamChat(
      {
        ...baseOpts,
        temperature: 0.3,
        maxTokens: 500,
        tools: [{ type: 'function', function: { name: 't', description: '', parameters: {} } }],
      },
      {},
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toHaveLength(1);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(500);
    expect(body.stream).toBe(true);
  });
});
