import { describe, expect, it, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBuiltinMidiServer } from '../src/main/builtinMidiServer';
import { MidiStore } from '../src/main/midiStore';
import { writeMidi } from '../src/shared/midi/writer';
import { createEmptyDocument, createEmptyTrack } from '../src/shared/midi/types';
import { parseMidi } from '../src/shared/midi/parser';

async function makeClient(store: MidiStore) {
  const { server } = createBuiltinMidiServer(store, () => 'test-session');
  const client = new Client({ name: 'test', version: '0' });
  const [cT, sT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(cT), client.connect(sT)]);
  return client;
}

async function call(client: Client, name: string, args: unknown): Promise<{ ok: boolean; [k: string]: unknown }> {
  const res = await client.callTool({ name, arguments: args as Record<string, unknown> });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? '{}';
  return JSON.parse(text);
}

describe('内置 MIDI MCP 服务', () => {
  let store: MidiStore;
  beforeEach(() => {
    store = new MidiStore(null);
  });

  it('工具列表注册完整', async () => {
    const client = await makeClient(store);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(['analyze_midi', 'create_midi', 'list_midis', 'modify_midi']);
    await client.close();
  });

  it('create_midi 创建并可通过 writeMidi 序列化', async () => {
    const client = await makeClient(store);
    const result = await call(client, 'create_midi', {
      title: '测试旋律',
      tempo: 96,
      timeSignature: '4/4',
      tracks: [
        {
          name: '主旋律',
          program: 73,
          notes: [
            { noteName: 'C5', start: 0, duration: 1, velocity: 88 },
            { noteName: 'D5', start: 1, duration: 0.5, velocity: 92 },
            { pitch: 74, start: 1.5, duration: 1.5, velocity: 85 },
            { noteName: 'G4', start: 3, duration: 1, velocity: 80 },
          ],
        },
        {
          name: '鼓',
          isDrum: true,
          notes: [
            { pitch: 36, start: 0, duration: 0.5, velocity: 100 },
            { pitch: 38, start: 1, duration: 0.5, velocity: 90 },
            { pitch: 42, start: 0.5, duration: 0.5, velocity: 60 },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.midiId).toBeTruthy();
    const meta = result.midiAsset as { noteCount: number; barCount: number; tempoBpm: number };
    expect(meta.noteCount).toBe(7);
    expect(meta.tempoBpm).toBe(96);

    const found = store.get(result.midiId as string)!;
    const parsed = parseMidi(found.bytes);
    expect(parsed.tracks).toHaveLength(3); // conductor + 2
    expect(parsed.tracks[1].program).toBe(73);
    expect(parsed.tracks[2].channel).toBe(9);
    await client.close();
  });

  it('create_midi 参数非法时报错', async () => {
    const client = await makeClient(store);
    const res = await client.callTool({
      name: 'create_midi',
      arguments: { tracks: [{ notes: [{ start: 0, duration: 1 }] }] }, // 缺 pitch/noteName
    });
    expect(res.isError).toBe(true);
    await client.close();
  });

  it('analyze_midi 输出完整分析', async () => {
    const client = await makeClient(store);
    const created = await call(client, 'create_midi', {
      title: '分析测试',
      tempo: 120,
      tracks: [
        {
          notes: Array.from({ length: 8 }, (_, i) => ({
            pitch: [60, 62, 64, 65, 67, 69, 71, 72][i],
            start: i,
            duration: 0.9,
            velocity: 80 + i,
          })),
        },
      ],
    });
    const analysis = await call(client, 'analyze_midi', { midiId: created.midiId });
    expect(analysis.ok).toBe(true);
    expect(analysis.key).toContain('C 大调');
    expect(analysis.chordsByBar).toHaveLength(2);
    const tracks = analysis.tracks as { controllers: Record<string, number>; velocity: { min: number; max: number } }[];
    expect(tracks[1].velocity.max - tracks[1].velocity.min).toBe(7);
    expect(analysis.suggestions).toBeTruthy();
    await client.close();
  });

  it('analyze_midi 找不到 id 时报错', async () => {
    const client = await makeClient(store);
    const res = await call(client, 'analyze_midi', { midiId: 'nonexist' });
    expect(res.ok).toBe(false);
    await client.close();
  });

  it('modify_midi 力度人性化 + CC11 + 换和弦全流程', async () => {
    const client = await makeClient(store);
    const created = await call(client, 'create_midi', {
      title: '修改测试',
      tempo: 110,
      tracks: [
        {
          name: '旋律',
          notes: Array.from({ length: 16 }, (_, i) => ({
            pitch: 60 + ((i * 3) % 9),
            start: i * 0.5,
            duration: 0.45,
            velocity: 90,
          })),
        },
      ],
    });
    const midiId = created.midiId as string;
    const modified = await call(client, 'modify_midi', {
      midiId,
      title: '修改测试-人性化',
      operations: [
        { type: 'humanize_velocity', amount: 0.6, seed: 42 },
        { type: 'auto_cc_curve', intensity: 0.6, seed: 43 },
        { type: 'change_chords', progression: [{ bar: 1, chord: 'Am' }, { bar: 2, chord: 'F' }], style: 'block' },
        { type: 'add_sustain' },
      ],
    });
    expect(modified.ok).toBe(true);
    expect(String(modified.message)).toContain('CC11');

    const newId = modified.midiId as string;
    const newDoc = store.getDoc(newId)!;
    expect(newId).not.toBe(midiId);
    expect(newDoc.tracks.length).toBe(3); // conductor + 旋律 + 新建 Chords
    expect(newDoc.tracks[1].controls.some((c) => c.controller === 11)).toBe(true);
    expect(newDoc.tracks[1].controls.some((c) => c.controller === 64)).toBe(true);
    expect(newDoc.tracks[1].notes.some((n) => n.velocity !== 90)).toBe(true);
    expect(newDoc.tracks[2].notes.length).toBeGreaterThanOrEqual(8);
    // 原 MIDI 保留
    expect(store.get(midiId)).toBeTruthy();
    await client.close();
  });

  it('modify_midi 移调与音色', async () => {
    const client = await makeClient(store);
    const created = await call(client, 'create_midi', {
      tracks: [{ notes: [{ pitch: 60, start: 0, duration: 1 }] }],
    });
    const modified = await call(client, 'modify_midi', {
      midiId: created.midiId,
      operations: [
        { type: 'transpose', semitones: 5 },
        { type: 'set_program', trackIndex: 1, program: 33 },
        { type: 'set_tempo', bpm: 140 },
      ],
    });
    const doc = store.getDoc(modified.midiId as string)!;
    expect(doc.tracks[1].notes[0].pitch).toBe(65);
    expect(doc.tracks[1].program).toBe(33);
    expect(doc.tracks[0].tempos[0].usPerQuarter).toBe(Math.round(60e6 / 140));
    await client.close();
  });

  it('list_midis 列出会话资产', async () => {
    const client = await makeClient(store);
    await call(client, 'create_midi', { title: 'A', tracks: [{ notes: [{ pitch: 60, start: 0, duration: 1 }] }] });
    await call(client, 'create_midi', { title: 'B', tracks: [{ notes: [{ pitch: 62, start: 0, duration: 1 }] }] });
    const list = await call(client, 'list_midis', {});
    expect(list.count).toBe(2);
    const midis = list.midis as { title: string }[];
    expect(midis.map((m) => m.title).sort()).toEqual(['A', 'B']);
    await client.close();
  });

  it('modify_midi 支持 set_cc_curve 与 auto_cc_curve min/max', async () => {
    const client = await makeClient(store);
    const created = await call(client, 'create_midi', {
      title: '曲线测试',
      tracks: [
        {
          notes: Array.from({ length: 16 }, (_, i) => ({ pitch: 60 + (i % 5) * 3, start: i * 0.5, duration: 0.45, velocity: 90 })),
        },
      ],
    });
    const modified = await call(client, 'modify_midi', {
      midiId: created.midiId,
      operations: [
        { type: 'set_cc_curve', curve: 'linear', points: [{ bar: 1, value: 0 }, { bar: 3, value: 110 }, { bar: 4, value: 30 }] },
        { type: 'auto_cc_curve', min: 0, max: 60, seed: 5 },
      ],
    });
    expect(modified.ok).toBe(true);
    const doc = store.getDoc(modified.midiId as string)!;
    // 最终生效的是 auto_cc_curve（后执行覆盖 set_cc_curve），值域应在 0-60
    const ccs = doc.tracks[1].controls.filter((c) => c.controller === 11);
    expect(ccs.length).toBeGreaterThan(0);
    expect(Math.max(...ccs.map((c) => c.value))).toBeLessThanOrEqual(60);
    expect(Math.min(...ccs.map((c) => c.value))).toBeGreaterThanOrEqual(0);
    // set_cc_curve 单独验证
    const only = await call(client, 'modify_midi', {
      midiId: created.midiId,
      operations: [{ type: 'set_cc_curve', curve: 'step', points: [{ bar: 1, value: 5 }, { bar: 2, value: 120 }] }],
    });
    const doc2 = store.getDoc(only.midiId as string)!;
    const ccs2 = doc2.tracks[1].controls.filter((c) => c.controller === 11);
    expect(ccs2.filter((c) => c.tick < 1920).every((c) => c.value === 5)).toBe(true);
    expect(ccs2.filter((c) => c.tick >= 1920).every((c) => c.value === 120)).toBe(true);
    await client.close();
  });

  it('MidiStore 磁盘持久化 round-trip', async () => {
    const { mkdtemp, rm } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = await mkdtemp(join(tmpdir(), 'supermidi-test-'));
    try {
      const s1 = new MidiStore(dir);
      await s1.init();
      const doc = createEmptyDocument(480);
      const t = createEmptyTrack('持久化', 40);
      t.notes.push({ pitch: 60, velocity: 90, startTick: 0, endTick: 480 });
      doc.tracks.push(t);
      const meta = await s1.create(doc, 'disk-test', 'generated');

      const s2 = new MidiStore(dir);
      await s2.init();
      const found = s2.get(meta.id);
      expect(found).toBeTruthy();
      expect(found!.meta.title).toBe('disk-test');
      const parsed = parseMidi(found!.bytes);
      expect(parsed.tracks[1].notes[0].pitch).toBe(60);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
