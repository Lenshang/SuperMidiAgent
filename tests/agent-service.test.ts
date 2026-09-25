import { describe, expect, it, vi } from 'vitest';
import { runAgent, sanitizeHistory, buildSystemPrompt, AgentDeps } from '../src/main/agentService';
import { AgentEvent, ModelProfile, WireMessage } from '../src/shared/types';
import { MidiStore } from '../src/main/midiStore';
import { KnowledgeBase } from '../src/main/knowledgeBase';
import { McpManager } from '../src/main/mcpManager';

const profile: ModelProfile = {
  id: 'p1',
  name: 'test',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'k',
  model: 'm',
  temperature: 0.2,
};

/** 模拟两段流式响应的工具调用会话。 */
function sse(events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

function sseResponse(events: object[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sse(events)));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function makeDeps(toolResult: { text: string; isError: boolean }, kbHits: unknown[] = []): AgentDeps {
  const midiStore = new MidiStore(null);
  const kb = new KnowledgeBase(null);
  const mcp = {
    getToolsForLlm: vi.fn().mockReturnValue([
      { exposedName: 'create_midi', serverId: 'builtin', toolName: 'create_midi', description: '创建', inputSchema: { type: 'object' } },
    ]),
    callTool: vi.fn().mockResolvedValue(toolResult),
  } as unknown as McpManager;
  vi.spyOn(kb, 'search').mockReturnValue(kbHits as never);
  return { mcp, kb, midiStore };
}

describe('sanitizeHistory', () => {
  it('注入系统提示并过滤孤立 tool 消息', () => {
    const history: WireMessage[] = [
      { role: 'system', content: 'old' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a1', type: 'function', function: { name: 't', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a1', content: 'ok' },
      { role: 'tool', tool_call_id: 'orphan', content: '孤儿结果' }, // 没有对应的 assistant tool_calls
      { role: 'assistant', content: '没有结果的调用', tool_calls: [{ id: 'lost', type: 'function', function: { name: 't', arguments: '{}' } }] },
    ];
    const out = sanitizeHistory(history, 'SYS');
    expect(out[0].content).toBe('SYS');
    const assistantMsgs = out.filter((m) => m.role === 'assistant');
    // a1 有结果保留；lost 无结果，降级为纯文本
    expect(assistantMsgs).toHaveLength(2);
    expect(assistantMsgs[1].content).toBe('没有结果的调用');
    expect(assistantMsgs[1].tool_calls).toBeUndefined();
    const toolMsgs = out.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(1);
    expect((toolMsgs[0] as { tool_call_id?: string }).tool_call_id).toBe('a1');
  });
});

describe('buildSystemPrompt', () => {
  it('包含会话 MIDI 与知识库上下文', () => {
    const prompt = buildSystemPrompt({
      sessionMidis: [
        {
          id: 'abc123', title: '旋律', tempoBpm: 120, barCount: 8, noteCount: 32, trackCount: 2,
          durationSec: 16, tracks: [], source: 'generated', createdAt: 0,
        },
      ],
      kbContext: '[1] (知识) CC11 用于表情',
    });
    expect(prompt).toContain('midiId=abc123');
    expect(prompt).toContain('CC11 用于表情');
    expect(prompt).toContain('create_midi');
    expect(prompt).toContain('modify_midi');
  });
});

describe('runAgent', () => {
  it('纯文本回复：直接结束', async () => {
    global.fetch = vi.fn().mockResolvedValue(sseResponse([
      { choices: [{ delta: { content: '你好！' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 10 } },
    ])) as unknown as typeof fetch;

    const events: AgentEvent[] = [];
    const deps = makeDeps({ text: '', isError: false });
    await runAgent(
      { runId: 'r1', sessionId: 's1', messages: [{ role: 'user', content: '打个招呼' }], profile, kbEnabled: false, maxIterations: 3, emit: (e) => events.push(e), signal: new AbortController().signal },
      deps,
    );
    expect(events.map((e) => e.type)).toEqual(['run_start', 'text_delta', 'done']);
    expect(events[1].type === 'text_delta' && events[1].delta).toBe('你好！');
  });

  it('工具调用循环：文本 → 工具 → 汇总', async () => {
    const midiStore = new MidiStore(null);
    // 预置一个资产供 extractAssets 使用
    const { createEmptyDocument, createEmptyTrack } = await import('../src/shared/midi/types');
    const doc = createEmptyDocument(480);
    const track = createEmptyTrack('旋律', 0);
    track.notes.push({ pitch: 60, velocity: 90, startTick: 0, endTick: 480 });
    doc.tracks.push(track);
    const meta = await midiStore.create(doc, '生成', 'generated', { sessionId: 's1' });

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return sseResponse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', function: { name: 'create_midi', arguments: '{"title":"歌"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]);
      }
      return sseResponse([
        { choices: [{ delta: { content: '已为你生成旋律。' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    }) as unknown as typeof fetch;

    const events: AgentEvent[] = [];
    const deps: AgentDeps = {
      midiStore,
      kb: new KnowledgeBase(null),
      mcp: {
        getToolsForLlm: () => [{ exposedName: 'create_midi', serverId: 'builtin', toolName: 'create_midi', description: '', inputSchema: {} }],
        callTool: async () => ({ text: JSON.stringify({ ok: true, message: '已创建', midiId: meta.id, midiAsset: meta }), isError: false }),
      } as unknown as McpManager,
    };
    await runAgent(
      { runId: 'r2', sessionId: 's1', messages: [{ role: 'user', content: '生成一段旋律' }], profile, kbEnabled: false, maxIterations: 4, emit: (e) => events.push(e), signal: new AbortController().signal },
      deps,
    );

    const types = events.map((e) => e.type);
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_end');
    expect(types[types.length - 1]).toBe('done');
    const toolEnd = events.find((e) => e.type === 'tool_end') as Extract<AgentEvent, { type: 'tool_end' }>;
    expect(toolEnd.midiAssets).toHaveLength(1);
    expect(toolEnd.midiAssets[0].id).toBe(meta.id);
    expect(toolEnd.summary).toBe('已创建');
    // 第二次请求应包含 tool 结果消息
    const secondCallBody = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(secondCallBody.messages.some((m: WireMessage) => m.role === 'tool' && m.tool_call_id === 'call1')).toBe(true);
  });

  it('知识库上下文注入', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]));
    global.fetch = fetchMock as unknown as typeof fetch;
    const deps = makeDeps({ text: '', isError: false }, [
      { sourcePath: '/k/a.md', title: 'a.md', chunkIndex: 0, score: 5, text: '知识内容ABC' },
    ]);
    await runAgent(
      { runId: 'r3', sessionId: 's1', messages: [{ role: 'user', content: '讲讲 CC11' }], profile, kbEnabled: true, maxIterations: 3, emit: () => {}, signal: new AbortController().signal },
      deps,
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('知识内容ABC');
  });

  it('模型错误转发为 error 事件', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'invalid key' } }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const events: AgentEvent[] = [];
    await runAgent(
      { runId: 'r4', sessionId: 's1', messages: [{ role: 'user', content: 'x' }], profile, kbEnabled: false, maxIterations: 3, emit: (e) => events.push(e), signal: new AbortController().signal },
      makeDeps({ text: '', isError: false }),
    );
    const err = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
    expect(err.message).toContain('invalid key');
  });

  it('达到最大迭代次数后停止', async () => {
    global.fetch = vi.fn().mockImplementation(async () =>
      sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'create_midi', arguments: '{}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]),
    ) as unknown as typeof fetch;
    const events: AgentEvent[] = [];
    await runAgent(
      { runId: 'r5', sessionId: 's1', messages: [{ role: 'user', content: 'x' }], profile, kbEnabled: false, maxIterations: 2, emit: (e) => events.push(e), signal: new AbortController().signal },
      makeDeps({ text: JSON.stringify({ ok: true }), isError: false }),
    );
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    const done = events[events.length - 1] as Extract<AgentEvent, { type: 'done' }>;
    expect(done.finishReason).toBe('max_iterations');
  });

  it('中止后正常结束', async () => {
    const controller = new AbortController();
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      controller.abort();
      return sseResponse([{ choices: [{ delta: { content: 'x' } }] }]);
    }) as unknown as typeof fetch;
    const events: AgentEvent[] = [];
    await runAgent(
      { runId: 'r6', sessionId: 's1', messages: [{ role: 'user', content: 'x' }], profile, kbEnabled: false, maxIterations: 3, emit: (e) => events.push(e), signal: controller.signal },
      makeDeps({ text: '', isError: false }),
    );
    const last = events[events.length - 1];
    expect(last.type === 'done' || last.type === 'error').toBe(true);
  });
});
