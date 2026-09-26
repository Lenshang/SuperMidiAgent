/** 内置 MIDI MCP 服务：create_midi / analyze_midi / modify_midi / list_midis。 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MidiStore } from './midiStore';
import { createEmptyDocument, createEmptyTrack, DEFAULT_US_PER_QUARTER, DRUM_CHANNEL } from '../shared/midi/types';
import { parseNoteName } from '../shared/midi/notes';
import { applyOperations, MidiOperation } from '../shared/midi/ops';
import { analyzeStats, detectChordsByBar } from '../shared/midi/analysis';
import { usPerQuarterOf } from '../shared/midi/timing';
import { formatPitch } from '../shared/midi/notes';
import { GM_PROGRAM_NAMES } from './gmPrograms';

const noteSchema = z
  .object({
    pitch: z.number().int().min(0).max(127).optional().describe('MIDI 音高 0-127（60 = C4）'),
    noteName: z.string().optional().describe('音名写法（如 "C4"、"F#3"、"Bb2"），与 pitch 二选一'),
    start: z.number().describe('起始位置（拍，以四分音符为单位，小节从 0 开始计拍）'),
    duration: z.number().positive().describe('时值（拍）'),
    velocity: z.number().int().min(1).max(127).optional().describe('力度 1-127，默认 90'),
  })
  .refine((n) => n.pitch !== undefined || !!n.noteName, { message: 'pitch 与 noteName 必须提供其一' });

const trackSchema = z.object({
  name: z.string().optional().describe('轨道名称'),
  program: z
    .number()
    .int()
    .min(0)
    .max(127)
    .optional()
    .describe('GM 音色编号 0-127（0=钢琴, 4=电钢琴, 11=颤音琴, 24=尼龙吉他, 33=贝斯, 40=小提琴, 48=弦乐合奏, 56=小号, 73=长笛, 80=合成器lead）'),
  isDrum: z.boolean().optional().describe('是否为鼓组轨道（使用通道 10）'),
  notes: z.array(noteSchema).min(1).max(512).describe('音符列表'),
});

const progressionSchema = z.object({
  bar: z.number().int().min(1).describe('小节号（1 开始）'),
  chord: z.string().nullable().describe('和弦符号，如 "C"、"Am"、"F"、"G7"、"Cmaj7"、"F#m7b5"、"Gsus4"、"Cadd9"、"C/E"；null 表示该小节无和弦'),
});

const operationSchema: z.ZodType<MidiOperation> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('transpose'),
    semitones: z.number().min(-60).max(60).describe('移调半音数，正数升调负数降调'),
    trackIndex: z.number().int().optional().describe('轨道序号（0 开始，含 0 号速度轨），缺省作用于所有音符轨道'),
  }),
  z.object({
    type: z.literal('humanize_velocity'),
    trackIndex: z.number().int().optional(),
    amount: z.number().min(0).max(1).optional().describe('强度 0-1，默认 0.55'),
    seed: z.number().int().optional().describe('随机种子，相同种子结果可复现'),
  }),
  z.object({
    type: z.literal('humanize_timing'),
    trackIndex: z.number().int().optional(),
    amount: z.number().min(0).max(1).optional().describe('强度 0-1，默认 0.3'),
    seed: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('auto_cc_curve'),
    controller: z.number().int().min(0).max(127).optional().describe('CC 控制器号，默认 11（表情）；也常用 CC1（调制/颤音）、CC2（气息）等，取决于目标音源'),
    trackIndex: z.number().int().optional().describe('缺省作用于所有音符轨道'),
    intensity: z.number().min(0).max(1).optional().describe('起伏/颤动强度 0-1，默认 0.5'),
    seed: z.number().int().optional(),
    min: z.number().int().min(0).max(127).optional().describe('曲线值域下限 0-127，默认 40；用户要求低值/弱奏时可设为 0-40'),
    max: z.number().int().min(0).max(127).optional().describe('曲线值域上限 0-127，默认 122；曲线严格落在 [min, max] 内'),
  }),
  z.object({
    type: z.literal('set_cc_curve'),
    controller: z.number().int().min(0).max(127).optional().describe('控制器号，默认 11（表情）'),
    points: z
      .array(
        z.object({
          bar: z.number().int().min(1).describe('小节号（1 开始）'),
          beat: z.number().min(0).max(16).optional().describe('小节内拍位置（0 = 小节头），默认 0'),
          value: z.number().int().min(0).max(127).describe('该点的值 0-127'),
        }),
      )
      .min(2)
      .max(64)
      .describe('控制点列表（至少 2 个），曲线覆盖整个文档：首点之前保持首点值，末点之后保持末点值'),
    curve: z.enum(['linear', 'smooth', 'step']).optional().describe('插值：linear=直线 smooth=平滑弧线（默认） step=阶梯保持'),
    trackIndex: z.number().int().optional().describe('缺省作用于所有音符轨道'),
  }),
  z.object({
    type: z.literal('set_pitch_bend'),
    points: z
      .array(
        z.object({
          bar: z.number().int().min(1).describe('小节号（1 开始）'),
          beat: z.number().min(0).max(16).optional().describe('小节内拍位置（0 = 小节头），默认 0'),
          semitones: z.number().min(-24).max(24).describe('该点的弯音量（半音，负=下弯 正=上弯）；相对音源的弯音范围'),
        }),
      )
      .min(2)
      .max(64)
      .describe('弯音控制点（至少 2 个），曲线覆盖整个文档：例如从 -2 扫到 +2 做上滑音'),
    curve: z.enum(['linear', 'smooth', 'step']).optional().describe('插值：linear=直线（默认） smooth=平滑弧线 step=阶梯保持'),
    rangeSemitones: z
      .number()
      .min(1)
      .max(24)
      .optional()
      .describe('音源的实际弯音范围（半音），GM 默认 ±2；换算用，只影响数值的映射比例'),
    trackIndex: z.number().int().optional().describe('缺省作用于所有非鼓组音符轨道'),
  }),
  z.object({
    type: z.literal('add_sustain'),
    trackIndex: z.number().int().optional(),
    gapBeats: z.number().min(0).max(4).optional().describe('换踏默认按小节边界进行（先抬后踩）；同一小节内静默超过 max(该值, 1) 拍时提前换踏，默认 0.25'),
  }),
  z.object({
    type: z.literal('quantize'),
    trackIndex: z.number().int().optional(),
    grid: z.number().optional().describe('量化网格（拍）：0.25=十六分 0.5=八分 1=四分，默认 0.25'),
    strength: z.number().min(0).max(1).optional().describe('量化强度 0-1，默认 1'),
  }),
  z.object({
    type: z.literal('scale_velocity'),
    factor: z.number().min(0.1).max(3).describe('力度缩放系数'),
    trackIndex: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('change_chords'),
    progression: z.array(progressionSchema).min(1).max(256).describe('和弦进行：每项 {bar, chord}；后续小节自动延续最后一个和弦'),
    trackIndex: z.number().int().optional().describe('目标轨道；缺省则新建和弦轨道'),
    createTrackIfMissing: z.boolean().optional().describe('目标轨道不存在时是否新建，默认 true'),
    trackName: z.string().optional().describe('新建轨道名，默认 "Chords"'),
    program: z.number().int().min(0).max(127).optional().describe('新建轨道的 GM 音色'),
    style: z.enum(['block', 'arpeggio', 'broken']).optional().describe('伴奏织体：block=柱式 arpeggio=琶音 broken=分解，默认 block'),
    velocity: z.number().int().min(1).max(127).optional().describe('和弦力度，默认 68'),
    overwrite: z.boolean().optional().describe('是否清空目标轨道已有音符，默认 true'),
  }),
  z.object({ type: z.literal('set_tempo'), bpm: z.number().min(20).max(300).describe('速度 BPM') }),
  z.object({
    type: z.literal('add_tempo_change'),
    bar: z.number().int().min(1).describe('从第几小节开始'),
    bpm: z.number().min(20).max(300),
  }),
  z.object({
    type: z.literal('set_program'),
    trackIndex: z.number().int().optional().describe('缺省为第一个有音符的轨道'),
    program: z.number().int().min(0).max(127).describe('GM 音色编号'),
  }),
  z.object({ type: z.literal('set_track_name'), trackIndex: z.number().int(), name: z.string() }),
  z.object({ type: z.literal('delete_track'), trackIndex: z.number().int() }),
]);

export interface BuiltinServerHandles {
  server: McpServer;
}

export function createBuiltinMidiServer(store: MidiStore, getSessionId: () => string | undefined): BuiltinServerHandles {
  const server = new McpServer({ name: 'supermidi', version: '0.1.0' });

  server.registerTool(
    'create_midi',
    {
      title: '创建 MIDI',
      description:
        '从明确的音符数据创建一段新的 MIDI。你必须给出每个音符的音高、起始（拍）、时值（拍）与力度。' +
        '适合：生成旋律、和弦、贝斯线、鼓点等。鼓组轨道设 isDrum=true，鼓组常用音高：36=底鼓 38=军鼓 42=闭镲 46=开镲 49=吊镲。' +
        '力度建议：旋律 70-105，伴奏 55-80；同一轨道不要全部用同一力度，应随乐句起伏。' +
        '需要延音踏板、力度起伏、CC 曲线等润饰时，直接放进 operations 参数一次性完成，避免生成后再追加修改版本。' +
        '返回 midiId 供后续 analyze/modify 使用。节奏建议为规整网格（如 0.5 或 0.25 拍的倍数）。',
      inputSchema: z.object({
        title: z.string().optional().describe('作品标题'),
        tempo: z.number().min(20).max(300).optional().describe('速度 BPM，默认 120'),
        timeSignature: z.string().optional().describe('拍号，如 "4/4"、"3/4"、"6/8"，默认 "4/4"'),
        tracks: z.array(trackSchema).min(1).max(8).describe('轨道列表（至少 1 条）'),
        operations: z
          .array(operationSchema)
          .max(12)
          .optional()
          .describe('创建后立即应用的操作（与 modify_midi 相同），如 add_sustain、humanize_velocity、auto_cc_curve；润饰应在此一次完成'),
      }),
    },
    async (args) => {
      const doc = createEmptyDocument(480);
      const tempo = args.tempo ?? 120;
      doc.tracks[0].tempos = [{ tick: 0, usPerQuarter: usPerQuarterOf(tempo) }];
      const sig = parseTimeSignature(args.timeSignature ?? '4/4');
      doc.tracks[0].timeSignatures = [{ tick: 0, numerator: sig[0], denominator: sig[1] }];

      args.tracks.forEach((t) => {
        const track = createEmptyTrack(t.name ?? '', t.program ?? 0);
        if (t.isDrum) track.channel = DRUM_CHANNEL;
        for (const n of t.notes) {
          const pitch = n.pitch !== undefined ? n.pitch : parseNoteName(n.noteName!);
          const startTick = Math.round(n.start * 480);
          const endTick = Math.max(startTick + 1, Math.round((n.start + n.duration) * 480));
          track.notes.push({ pitch, velocity: n.velocity ?? 90, startTick, endTick });
        }
        track.notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
        doc.tracks.push(track);
      });

      let finalDoc = doc;
      let polish = '';
      const ops = args.operations ?? [];
      if (ops.length > 0) {
        try {
          const r = applyOperations(doc, ops);
          finalDoc = r.doc;
          polish = `；润饰：${r.summary}`;
        } catch (err) {
          return textError(`操作执行失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const meta = await store.create(finalDoc, args.title ?? '', 'generated', { sessionId: getSessionId() });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, message: `已创建 MIDI「${meta.title}」：${meta.barCount} 小节 ${meta.noteCount} 个音符${polish}`, ...assetPayload(meta) }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'analyze_midi',
    {
      title: '分析 MIDI',
      description:
        '深入分析一个 MIDI：轨道与音色、速度、拍号、调性、逐小节和弦、力度分布、CC 控制器情况。' +
        '在修改 MIDI 之前建议先分析，以了解现状。',
      inputSchema: z.object({ midiId: z.string().describe('MIDI 资产 id') }),
    },
    async (args) => {
      const found = store.get(args.midiId);
      if (!found) return textError(`找不到 MIDI 资产 ${args.midiId}，可调用 list_midis 查看可用列表`);
      const doc = store.getDoc(args.midiId);
      if (!doc) return textError('MIDI 数据解析失败');
      const stats = analyzeStats(doc);
      const chords = detectChordsByBar(doc);
      const report = {
        ok: true,
        midiId: args.midiId,
        title: found.meta.title,
        durationSec: Math.round(stats.durationSec * 10) / 10,
        barCount: stats.barCount,
        tempoBpm: stats.tempoBpm,
        tempoChanges: stats.tempoChanges,
        timeSignature: stats.timeSignatures[0],
        key: `${stats.key.tonicName} ${stats.key.mode === 'major' ? '大调' : '小调'}（置信度 ${(stats.key.confidence * 100).toFixed(0)}%）`,
        totalNotes: stats.totalNotes,
        tracks: stats.tracks.map((t) => ({
          index: t.index,
          name: t.name,
          program: `${t.program}(${GM_PROGRAM_NAMES[t.program] ?? '?'})`,
          noteCount: t.noteCount,
          pitchRange: t.pitchRange ? `${formatPitch(t.pitchRange[0])} ~ ${formatPitch(t.pitchRange[1])}` : null,
          velocity: t.noteCount ? { min: t.minVelocity, max: t.maxVelocity, avg: t.avgVelocity } : null,
          controllers: Object.entries(t.controllerValues).map(([cc, v]) => ({
            cc: Number(cc),
            count: v.count,
            valueRange: [v.min, v.max],
          })),
          pitchBend: t.pitchBend ? { count: t.pitchBend.count, valueRange: [t.pitchBend.min, t.pitchBend.max] } : null,
        })),
        chordsByBar: chords.map((c) => ({ bar: c.bar, chord: c.chord })),
        notesPreview: doc.tracks
          .filter((t) => t.notes.length > 0)
          .slice(0, 4)
          .map((t) => ({
            track: t.name || `Track ${doc.tracks.indexOf(t)}`,
            first: t.notes.slice(0, 24).map((n) => `${formatPitch(n.pitch)}/${(n.startTick / 480).toFixed(2)}拍/v${n.velocity}`),
          })),
        suggestions: buildSuggestions(stats),
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(report) }] };
    },
  );

  server.registerTool(
    'modify_midi',
    {
      title: '修改 MIDI',
      description:
        '对一个已有 MIDI 执行一系列修改操作，生成新的 MIDI（原版本保留）。' +
        '常用操作：humanize_velocity（真实力度）、auto_cc_curve（为任意 CC 自动生成起伏曲线，controller 可选 11 表情/1 调制等）、' +
        'set_cc_curve（精确绘制任意 CC 曲线）、set_pitch_bend（精确绘制弯音/滑音曲线）、change_chords（改变和弦进行）、' +
        'transpose（移调）、quantize（量化）、add_sustain（延音踏板）、humanize_timing（微小时值偏移）、set_tempo、set_program（换音色）等。' +
        '操作按数组顺序依次执行。若尚未分析过该 MIDI，建议先调用 analyze_midi。',
      inputSchema: z.object({
        midiId: z.string().describe('要修改的 MIDI 资产 id'),
        title: z.string().optional().describe('新版本标题'),
        operations: z.array(operationSchema).min(1).max(12).describe('操作列表'),
      }),
    },
    async (args) => {
      const doc = store.getDoc(args.midiId);
      if (!doc) return textError(`找不到 MIDI 资产 ${args.midiId} 或无法解析`);
      let result;
      try {
        result = applyOperations(doc, args.operations as MidiOperation[]);
      } catch (err) {
        return textError(`操作执行失败：${err instanceof Error ? err.message : String(err)}`);
      }
      const parent = store.get(args.midiId);
      const meta = await store.create(result.doc, args.title ?? `${parent?.meta.title ?? 'MIDI'}-修改版`, 'modified', {
        sessionId: getSessionId(),
        parentIds: [args.midiId],
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              message: `修改完成：${result.summary}`,
              appliedOperations: args.operations.map((o) => o.type),
              ...assetPayload(meta),
            }),
          },
        ],
      };
    },
  );

  server.registerTool('list_midis', {
    title: '列出 MIDI',
    description: '列出当前会话中所有可用的 MIDI 资产（含 id、标题、统计），用于确认 midiId。',
    inputSchema: z.object({}),
  }, async () => {
    const list = store.list(getSessionId()).map((m) => ({
      id: m.id,
      title: m.title,
      source: m.source,
      tempoBpm: m.tempoBpm,
      barCount: m.barCount,
      noteCount: m.noteCount,
      durationSec: m.durationSec,
      tracks: m.tracks.map((t) => t.name),
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, count: list.length, midis: list }) }] };
  });

  return { server };
}

function assetPayload(meta: {
  id: string;
  title: string;
  tempoBpm: number;
  barCount: number;
  noteCount: number;
  trackCount: number;
  durationSec: number;
  tracks: { index: number; name: string; program: number; noteCount: number; ccCounts: Record<string, number> }[];
  source: string;
}) {
  return {
    midiId: meta.id,
    midiAsset: {
      id: meta.id,
      title: meta.title,
      tempoBpm: meta.tempoBpm,
      barCount: meta.barCount,
      noteCount: meta.noteCount,
      trackCount: meta.trackCount,
      durationSec: meta.durationSec,
      tracks: meta.tracks,
      source: meta.source,
    },
  };
}

function textError(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message }) }], isError: true as const };
}

function parseTimeSignature(s: string): [number, number] {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(s.trim());
  if (!m) return [4, 4];
  const den = parseInt(m[2], 10);
  return [parseInt(m[1], 10), [2, 4, 8, 16, 32].includes(den) ? den : 4];
}

function buildSuggestions(stats: ReturnType<typeof analyzeStats>): string[] {
  const tips: string[] = [];
  if (!stats.hasCC11) tips.push('尚无 CC11 表情曲线，可用 auto_cc_curve（自动起伏）或 set_cc_curve（精确绘制）为 CC11/CC1 等任意 CC 画曲线');
  const velIssue = stats.tracks.some((t) => t.noteCount > 8 && t.maxVelocity - t.minVelocity < 12);
  if (velIssue) tips.push('力度过于平直（max-min < 12），建议 humanize_velocity 增加真实感');
  if (!stats.hasSustain && stats.tracks.some((t) => t.noteCount > 0)) tips.push('暂无延音踏板（CC64）');
  if (tips.length === 0) tips.push('整体状态良好，可按需求进一步调整');
  return tips;
}
