/**
 * 真实 API 端到端测试（任何 OpenAI 兼容服务均可）。
 * 密钥只通过环境变量提供，绝不写入代码。
 * 运行：RUN_LIVE=1 TEST_API_KEY=sk-xxx TEST_MODEL=MiniMax-M3 TEST_BASE_URL=https://api.minimax.cn/v1 npm run test:live
 */
import { describe, expect, it } from 'vitest';
import { streamChat } from '../../src/main/openaiClient';
import { runAgent } from '../../src/main/agentService';
import { McpManager } from '../../src/main/mcpManager';
import { MidiStore } from '../../src/main/midiStore';
import { KnowledgeBase } from '../../src/main/knowledgeBase';
import { AgentEvent, ModelProfile, WireMessage } from '../../src/shared/types';
import { parseMidi } from '../../src/shared/midi/parser';

const TEST_API_KEY = process.env.TEST_API_KEY ?? '';
const PROFILE: ModelProfile = {
  id: 'live-test',
  name: 'live',
  baseUrl: process.env.TEST_BASE_URL ?? 'https://api.minimax.cn/v1',
  apiKey: TEST_API_KEY,
  model: process.env.TEST_MODEL ?? 'MiniMax-M3',
  temperature: 0.7,
};

const RUN = !!process.env.RUN_LIVE && TEST_API_KEY.length > 0;
const d = RUN ? describe : describe.skip;

async function collect(events: AgentEvent[]) {
  let text = '';
  const toolEnds: Extract<AgentEvent, { type: 'tool_end' }>[] = [];
  for (const e of events) {
    if (e.type === 'text_delta') text += e.delta;
    if (e.type === 'tool_end') toolEnds.push(e);
  }
  return { text, toolEnds };
}

d('MiniMax-M3 真实 API', () => {
  it('基础流式对话（不含工具）', { timeout: 120_000 }, async () => {
    const deltas: string[] = [];
    const result = await streamChat(
      {
        baseUrl: PROFILE.baseUrl,
        apiKey: PROFILE.apiKey,
        model: PROFILE.model,
        messages: [{ role: 'user', content: '用一句话介绍什么是 MIDI。' }],
        temperature: 0.7,
      },
      { onText: (delta) => deltas.push(delta) },
    );
    console.log('  [live] 流式增量数:', deltas.length, '| finish:', result.finishReason);
    expect(deltas.length).toBeGreaterThan(0);
    expect(result.content.length).toBeGreaterThan(4);
  });

  it('Agent 全流程：生成 C 大调旋律 → create_midi 工具 → 合法 MIDI 资产', { timeout: 300_000 }, async () => {
    const store = new MidiStore(null);
    const mcp = new McpManager(store, () => ({ builtinMcpEnabled: true, mcpServers: [] }));
    mcp.setSessionId('live-test');
    await mcp.init();
    const deps = { mcp, kb: new KnowledgeBase(null), midiStore: store };

    const events: AgentEvent[] = [];
    const messages: WireMessage[] = [
      { role: 'user', content: '请生成一段 C 大调、120 BPM、8 小节的钢琴旋律，要有清晰的乐句起伏。直接创作，不要问我细节。' },
    ];
    await runAgent(
      {
        runId: 'live-1',
        sessionId: 'live-test',
        messages,
        profile: PROFILE,
        kbEnabled: false,
        maxIterations: 8,
        emit: (e) => {
          events.push(e);
        },
        signal: new AbortController().signal,
      },
      deps,
    );

    const errors = events.filter((e) => e.type === 'error');
    if (errors.length > 0) console.log('  [live] 错误:', errors);
    const { text, toolEnds } = await collect(events);
    console.log('  [live] 工具调用:', toolEnds.map((t) => `${t.toolName}(${t.ok})`).join(', '));
    console.log('  [live] 回复长度:', text.length);

    expect(errors).toHaveLength(0);
    const createCalls = toolEnds.filter((t) => t.toolName.includes('create_midi'));
    expect(createCalls.length).toBeGreaterThanOrEqual(1);
    const assets = createCalls.flatMap((t) => t.midiAssets);
    expect(assets.length).toBeGreaterThanOrEqual(1);

    const asset = assets[0];
    expect(asset.barCount).toBeGreaterThanOrEqual(4);
    expect(asset.noteCount).toBeGreaterThanOrEqual(8);
    // 资产字节可解析为合法 MIDI
    const found = store.get(asset.id)!;
    const doc = parseMidi(found.bytes);
    expect(doc.ticksPerQuarter).toBeGreaterThan(0);
    const notes = doc.tracks.flatMap((t) => t.notes);
    expect(notes.length).toBe(asset.noteCount);
    // 力度不全部相同（模型应有基本力度设计）
    const vels = new Set(notes.map((n) => n.velocity));
    console.log('  [live] 音符数:', notes.length, '| 力度种类:', vels.size, '| 时长:', asset.durationSec, 's');
    await mcp.dispose();
  });

  it('Agent 二轮：分析并对已有 MIDI 添加真实力度与 CC11', { timeout: 300_000 }, async () => {
    const store = new MidiStore(null);
    const mcp = new McpManager(store, () => ({ builtinMcpEnabled: true, mcpServers: [] }));
    mcp.setSessionId('live-test-2');
    await mcp.init();
    const deps = { mcp, kb: new KnowledgeBase(null), midiStore: store };

    // 第一轮：生成
    const events1: AgentEvent[] = [];
    await runAgent(
      {
        runId: 'live-2a',
        sessionId: 'live-test-2',
        messages: [{ role: 'user', content: '生成一段 G 大调 16 小节的旋律，用原声钢琴。' }],
        profile: PROFILE,
        kbEnabled: false,
        maxIterations: 8,
        emit: (e) => events1.push(e),
        signal: new AbortController().signal,
      },
      deps,
    );
    const { toolEnds: ends1 } = await collect(events1);
    const created = ends1.flatMap((t) => t.midiAssets);
    expect(created.length).toBeGreaterThanOrEqual(1);
    const firstId = created[0].id;
    // 生成版不应已有 CC11（模型未要求）
    const firstDoc = store.getDoc(firstId)!;
    const firstCC11 = firstDoc.tracks.reduce((a, t) => a + t.controls.filter((c) => c.controller === 11).length, 0);
    console.log('  [live] 第一轮 midiId:', firstId, '| CC11 事件:', firstCC11);

    // 第二轮：要求加真实力度和 CC11
    const events2: AgentEvent[] = [];
    const messages: WireMessage[] = [
      { role: 'user', content: '生成一段 G 大调 16 小节的旋律，用原声钢琴。' },
      { role: 'assistant', content: '已生成。' },
      { role: 'user', content: `很好。请给 midiId=${firstId} 的旋律增加真实的力度起伏和真实的 CC11 表情控制，让它听起来更像真人演奏。` },
    ];
    await runAgent(
      {
        runId: 'live-2b',
        sessionId: 'live-test-2',
        messages,
        profile: PROFILE,
        kbEnabled: false,
        maxIterations: 10,
        emit: (e) => events2.push(e),
        signal: new AbortController().signal,
      },
      deps,
    );
    const errors = events2.filter((e) => e.type === 'error');
    if (errors.length > 0) console.log('  [live] 错误:', errors);
    const { toolEnds: ends2 } = await collect(events2);
    console.log('  [live] 第二轮工具:', ends2.map((t) => `${t.toolName}(${t.ok})`).join(', '));
    expect(errors).toHaveLength(0);

    const modified = ends2.filter((t) => t.toolName.includes('modify')).flatMap((t) => t.midiAssets);
    expect(modified.length).toBeGreaterThanOrEqual(1);
    const modMeta = modified[0];
    expect(modMeta.parentIds).toContain(firstId);
    const modDoc = store.getDoc(modMeta.id)!;
    const cc11 = modDoc.tracks.reduce((a, t) => a + t.controls.filter((c) => c.controller === 11).length, 0);
    const vels = new Set(modDoc.tracks.flatMap((t) => t.notes.map((n) => n.velocity)));
    console.log('  [live] 修改版 CC11 事件:', cc11, '| 力度种类:', vels.size);
    expect(cc11).toBeGreaterThan(10);
    expect(vels.size).toBeGreaterThan(2);
    await mcp.dispose();
  });
});
