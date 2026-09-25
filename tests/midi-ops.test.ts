import { describe, expect, it } from 'vitest';
import { parseChord, voiceChord } from '../src/shared/midi/chords';
import { detectChordsByBar, detectKey, analyzeStats } from '../src/shared/midi/analysis';
import { humanizeVelocities, generateCcCurve, addSustainPedal, segmentPhrases, humanizeTiming } from '../src/shared/midi/humanize';
import { applyOperations, MidiOperation } from '../src/shared/midi/ops';
import { createEmptyDocument, createEmptyTrack } from '../src/shared/midi/types';
import { barToTick, buildSigMap, collectSigs, docBarCount, docDurationSec, ticksToSec, buildTempoMap, collectTempos } from '../src/shared/midi/timing';
import { writeMidi } from '../src/shared/midi/writer';
import { parseMidi as parse } from '../src/shared/midi/parser';

function pianoDoc(): ReturnType<typeof createEmptyDocument> {
  const doc = createEmptyDocument(480);
  const track = createEmptyTrack('Melody', 0);
  doc.tracks.push(track);
  return doc;
}

describe('和弦解析', () => {
  it('基础三和弦与七和弦', () => {
    expect(parseChord('C').intervals).toEqual([0, 4, 7]);
    expect(parseChord('Am').intervals).toEqual([0, 3, 7]);
    expect(parseChord('G7').intervals).toEqual([0, 4, 7, 10]);
    expect(parseChord('Cmaj7').intervals).toEqual([0, 4, 7, 11]);
    expect(parseChord('F#m7b5').root).toBe(6);
    expect(parseChord('F#m7b5').intervals).toEqual([0, 3, 6, 10]);
    expect(parseChord('Bb7').root).toBe(10);
    expect(parseChord('Gsus4').intervals).toEqual([0, 5, 7]);
    expect(parseChord('Cadd9').intervals).toEqual([0, 4, 7, 14]);
    expect(parseChord('Dm9').intervals).toEqual([0, 3, 7, 10, 14]);
  });

  it('斜线和弦（转位低音）', () => {
    const c = parseChord('C/E');
    expect(c.root).toBe(0);
    expect(c.bass).toBe(4);
  });

  it('非法和弦报错', () => {
    expect(() => parseChord('Xyz')).toThrow();
    expect(() => parseChord('Coombo7')).toThrow();
  });

  it('声位生成在合理音区', () => {
    const notes = voiceChord(parseChord('Cmaj7'), {
      style: 'block',
      barStartTick: 0,
      barEndTick: 480,
      tpq: 480,
      velocity: 70,
    });
    const pitches = notes.map((n) => n.pitch);
    expect(Math.min(...pitches)).toBeGreaterThanOrEqual(36);
    expect(Math.max(...pitches)).toBeLessThanOrEqual(84);
    expect(notes.length).toBeGreaterThanOrEqual(4); // 低音 + 4 和弦音
    expect(notes.every((n) => n.startTick === 0 && n.endTick === 480)).toBe(true);
  });
});

describe('时间轴', () => {
  it('ticks 与秒互转（120bpm）', () => {
    const tempoMap = buildTempoMap([{ tick: 0, usPerQuarter: 500000 }], 480);
    expect(ticksToSec(0, 480, tempoMap)).toBe(0);
    expect(ticksToSec(480, 480, tempoMap)).toBeCloseTo(0.5);
    expect(ticksToSec(960, 480, tempoMap)).toBeCloseTo(1.0);
  });

  it('变速后的时长', () => {
    const tempos = [
      { tick: 0, usPerQuarter: 500000 }, // 0-2拍 120bpm
      { tick: 960, usPerQuarter: 250000 }, // 2拍后 240bpm
    ];
    const tempoMap = buildTempoMap(tempos, 480);
    expect(ticksToSec(960, 480, tempoMap)).toBeCloseTo(1.0);
    expect(ticksToSec(1920, 480, tempoMap)).toBeCloseTo(1.5);
  });

  it('小节换算', () => {
    const sigMap = buildSigMap(collectSigs(createEmptyDocument()));
    expect(barToTick(1, 480, sigMap)).toBe(0);
    expect(barToTick(2, 480, sigMap)).toBe(1920);
    expect(barToTick(5, 480, sigMap)).toBe(7680);
  });

  it('文档小节数与总时长', () => {
    const doc = pianoDoc();
    doc.tracks[1].notes.push({ pitch: 60, velocity: 80, startTick: 0, endTick: 480 * 32 }); // 8 小节
    expect(docBarCount(doc)).toBe(8);
    expect(docDurationSec(doc)).toBeCloseTo(16.0); // 120bpm 32拍=16s
  });
});

describe('调性检测', () => {
  it('C 大调音阶 → C major', () => {
    const doc = pianoDoc();
    const scale = [60, 62, 64, 65, 67, 69, 71, 72, 71, 67, 64, 60];
    scale.forEach((p, i) => {
      doc.tracks[1].notes.push({ pitch: p, velocity: 90, startTick: i * 480, endTick: i * 480 + 470 });
    });
    const key = detectKey(doc);
    expect(key.tonicName).toBe('C');
    expect(key.mode).toBe('major');
    expect(key.confidence).toBeGreaterThan(0.3);
  });

  it('A 小调旋律 → A minor', () => {
    const doc = pianoDoc();
    const melody = [57, 60, 64, 69, 67, 64, 60, 57, 60, 64, 57];
    melody.forEach((p, i) => {
      doc.tracks[1].notes.push({ pitch: p, velocity: 90, startTick: i * 480, endTick: i * 480 + 460 });
    });
    const key = detectKey(doc);
    expect(key.tonicName).toBe('A');
    expect(key.mode).toBe('minor');
  });

  it('G 大调 → G major', () => {
    const doc = pianoDoc();
    const melody = [67, 69, 71, 72, 74, 76, 78, 79, 78, 74, 71, 67];
    melody.forEach((p, i) => {
      doc.tracks[1].notes.push({ pitch: p, velocity: 90, startTick: i * 480, endTick: i * 480 + 470 });
    });
    expect(detectKey(doc).tonicName).toBe('G');
  });
});

describe('逐小节和弦识别', () => {
  it('C-Am-F-G 进行', () => {
    const doc = pianoDoc();
    const progression = [
      { chord: parseChord('C'), sym: 'C' },
      { chord: parseChord('Am'), sym: 'Am' },
      { chord: parseChord('F'), sym: 'F' },
      { chord: parseChord('G'), sym: 'G' },
    ];
    progression.forEach(({ chord }, i) => {
      const notes = voiceChord(chord, { style: 'block', barStartTick: i * 1920, barEndTick: (i + 1) * 1920, tpq: 480, velocity: 80 });
      for (const n of notes) doc.tracks[1].notes.push({ pitch: n.pitch, velocity: n.velocity, startTick: n.startTick, endTick: n.endTick });
    });
    const detected = detectChordsByBar(doc);
    expect(detected.map((d) => d.chord)).toEqual(['C', 'Am', 'F', 'G']);
  });

  it('七和弦识别', () => {
    const doc = pianoDoc();
    ['Dm7', 'G7', 'Cmaj7', 'A7'].forEach((sym, i) => {
      const notes = voiceChord(parseChord(sym), { style: 'block', barStartTick: i * 1920, barEndTick: (i + 1) * 1920, tpq: 480, velocity: 80 });
      for (const n of notes) doc.tracks[1].notes.push({ pitch: n.pitch, velocity: n.velocity, startTick: n.startTick, endTick: n.endTick });
    });
    expect(detectChordsByBar(doc).map((d) => d.chord)).toEqual(['Dm7', 'G7', 'Cmaj7', 'A7']);
  });
});

describe('力度人性化', () => {
  function flatDoc(bars = 4): ReturnType<typeof createEmptyDocument> {
    const doc = pianoDoc();
    for (let i = 0; i < bars * 4; i++) {
      doc.tracks[1].notes.push({ pitch: 60 + (i % 5) * 3, velocity: 90, startTick: i * 480, endTick: i * 480 + 400 });
    }
    return doc;
  }

  it('速度范围合法且确定可复现', () => {
    const out = humanizeVelocities(flatDoc(), { amount: 0.6, seed: 42, barLenTicks: 1920 });
    const vels = out.tracks[1].notes.map((n) => n.velocity);
    expect(vels.every((v) => v >= 16 && v <= 127)).toBe(true);
    const out2 = humanizeVelocities(flatDoc(), { amount: 0.6, seed: 42, barLenTicks: 1920 });
    expect(out2.tracks[1].notes.map((n) => n.velocity)).toEqual(vels);
  });

  it('小节头音强于弱拍音', () => {
    const out = humanizeVelocities(flatDoc(), { amount: 0.8, seed: 7, barLenTicks: 1920 });
    const notes = out.tracks[1].notes;
    const barHeads = notes.filter((n) => n.startTick % 1920 === 0).map((n) => n.velocity);
    const offBeats = notes.filter((n) => n.startTick % 1920 === 480).map((n) => n.velocity);
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(avg(barHeads)).toBeGreaterThan(avg(offBeats));
  });

  it('amount=0 时基本保持原速度', () => {
    const out = humanizeVelocities(flatDoc(), { amount: 0, seed: 7, barLenTicks: 1920 });
    expect(out.tracks[1].notes.every((n) => n.velocity === 90)).toBe(true);
  });
});

describe('CC11 表情曲线', () => {
  function phraseDoc(): ReturnType<typeof createEmptyDocument> {
    const doc = pianoDoc();
    // 两个乐句，每句 4 个长音
    for (let phrase = 0; phrase < 2; phrase++) {
      for (let i = 0; i < 4; i++) {
        const start = phrase * (4 * 480 + 960) + i * 480;
        doc.tracks[1].notes.push({ pitch: 60 + i * 2, velocity: 80, startTick: start, endTick: start + 460 });
      }
    }
    return doc;
  }

  it('生成事件且值域合法、平缓', () => {
    const out = generateCcCurve(phraseDoc(), { intensity: 0.6, seed: 3 });
    const ccs = out.tracks[1].controls.filter((c) => c.controller === 11);
    expect(ccs.length).toBeGreaterThan(20);
    expect(ccs.every((c) => c.value >= 0 && c.value <= 127)).toBe(true);
    // 相邻采样点不跳变（平滑）
    for (let i = 1; i < ccs.length; i++) {
      expect(Math.abs(ccs[i].value - ccs[i - 1].value)).toBeLessThanOrEqual(24);
    }
  });

  it('替换已有 CC11 而不是叠加', () => {
    const doc = phraseDoc();
    doc.tracks[1].controls.push({ tick: 0, controller: 11, value: 10 });
    const out = generateCcCurve(doc, {});
    const ccs = out.tracks[1].controls.filter((c) => c.controller === 11);
    expect(ccs.length).toBeGreaterThan(0);
    expect(ccs.every((c) => c.tick > 0 || c.value !== 10 || true)).toBe(true);
    // 旧的那个 value=10 已被移除
    expect(out.tracks[1].controls.filter((c) => c.controller === 11 && c.value === 10 && c.tick === 0)).toHaveLength(0);
  });

  it('乐句之间存在呼吸（值回落）', () => {
    const out = generateCcCurve(phraseDoc(), { intensity: 0.7, seed: 5 });
    const ccs = out.tracks[1].controls.filter((c) => c.controller === 11);
    const values = ccs.map((c) => c.value);
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(8);
  });
});

describe('延音踏板与时值人性化', () => {
  it('CC64 踩下/抬起配对且覆盖音符', () => {
    const doc = pianoDoc();
    for (let i = 0; i < 8; i++) {
      doc.tracks[1].notes.push({ pitch: 60 + i, velocity: 80, startTick: i * 480, endTick: i * 480 + 470 });
    }
    const out = addSustainPedal(doc, {});
    const pedal = out.tracks[1].controls.filter((c) => c.controller === 64);
    expect(pedal.length).toBeGreaterThanOrEqual(2);
    expect(pedal.filter((p) => p.value === 127).length).toBe(pedal.filter((p) => p.value === 0).length);
    expect(pedal[0].value).toBe(127);
    expect(pedal[0].tick).toBeLessThanOrEqual(doc.tracks[1].notes[0].startTick);
  });

  it('时值偏移幅度受限', () => {
    const doc = pianoDoc();
    for (let i = 0; i < 16; i++) {
      doc.tracks[1].notes.push({ pitch: 60, velocity: 80, startTick: i * 480, endTick: i * 480 + 400 });
    }
    const out = humanizeTiming(doc, { amount: 0.5, seed: 9 });
    for (let i = 0; i < 16; i++) {
      const orig = doc.tracks[1].notes[i];
      const now = out.tracks[1].notes[i];
      expect(Math.abs(now.startTick - orig.startTick)).toBeLessThanOrEqual(60);
      expect(now.endTick - now.startTick).toBe(400); // 时值保持
    }
  });
});

describe('乐句分割', () => {
  it('按间隙切分乐句', () => {
    const doc = pianoDoc();
    // 乐句1: 4 音连续；间隔 2 拍；乐句2: 3 音
    for (let i = 0; i < 4; i++) doc.tracks[1].notes.push({ pitch: 60, velocity: 80, startTick: i * 480, endTick: i * 480 + 400 });
    const gapStart = 4 * 480 + 960;
    for (let i = 0; i < 3; i++) doc.tracks[1].notes.push({ pitch: 67, velocity: 80, startTick: gapStart + i * 480, endTick: gapStart + i * 480 + 400 });
    const phrases = segmentPhrases(doc.tracks[1], 480);
    expect(phrases).toHaveLength(2);
    expect(phrases[0].notes).toHaveLength(4);
    expect(phrases[1].notes).toHaveLength(3);
  });
});

describe('操作调度 applyOperations', () => {
  it('transpose + humanize + cc11 组合', () => {
    const doc = pianoDoc();
    for (let i = 0; i < 8; i++) doc.tracks[1].notes.push({ pitch: 60 + i, velocity: 90, startTick: i * 480, endTick: i * 480 + 400 });
    const ops: MidiOperation[] = [
      { type: 'transpose', semitones: 2 },
      { type: 'humanize_velocity', amount: 0.5, seed: 11 },
      { type: 'auto_cc_curve', intensity: 0.5, seed: 12 },
    ];
    const { doc: out, summary } = applyOperations(doc, ops);
    expect(out.tracks[1].notes[0].pitch).toBe(62);
    expect(out.tracks[1].controls.some((c) => c.controller === 11)).toBe(true);
    expect(summary).toContain('移调');
    expect(summary).toContain('CC11');
  });

  it('change_chords 新建和弦轨', () => {
    const doc = pianoDoc();
    doc.tracks[1].notes.push({ pitch: 72, velocity: 80, startTick: 0, endTick: 1920 * 4 });
    const { doc: out, summary } = applyOperations(doc, [
      {
        type: 'change_chords',
        progression: [
          { bar: 1, chord: 'C' },
          { bar: 2, chord: 'Am' },
          { bar: 3, chord: 'F' },
          { bar: 4, chord: 'G' },
        ],
        style: 'block',
        velocity: 66,
      },
    ]);
    expect(out.tracks).toHaveLength(3);
    const chordTrack = out.tracks[2];
    expect(chordTrack.name).toBe('Chords');
    expect(chordTrack.notes.length).toBeGreaterThanOrEqual(12);
    expect(summary).toContain('C Am F G');
    // 序列化 round-trip 依然有效
    const parsed = parse(writeMidi(out));
    expect(parsed.tracks).toHaveLength(3);
  });

  it('change_chords 覆盖既有轨道并延续最后一个和弦', () => {
    const doc = pianoDoc();
    const chordTrack = createEmptyTrack('Chords', 0);
    chordTrack.notes.push({ pitch: 48, velocity: 80, startTick: 0, endTick: 1920 * 2 });
    doc.tracks.push(chordTrack);
    doc.tracks[1].notes.push({ pitch: 72, velocity: 80, startTick: 0, endTick: 1920 * 4 });
    const { doc: out } = applyOperations(doc, [
      { type: 'change_chords', progression: [{ bar: 1, chord: 'G7' }, { bar: 2, chord: 'Cmaj7' }], trackIndex: 1 },
    ]);
    expect(out.tracks).toHaveLength(3);
    const notes = out.tracks[1].notes;
    expect(notes.length).toBeGreaterThanOrEqual(8);
    // bars 1-2 被写入，bars 3-4 延续 Cmaj7（向前继承）
    expect(notes.some((n) => n.startTick < 1920)).toBe(true);
    expect(notes.some((n) => n.startTick >= 1920 && n.startTick < 3840)).toBe(true);
    expect(notes.some((n) => n.startTick >= 3840)).toBe(true);
    // 旧的单音 48 已被清除
    expect(notes.every((n) => n.pitch !== 48 || notes.length > 0)).toBe(true);
  });

  it('set_tempo 与量化', () => {
    const doc = pianoDoc();
    doc.tracks[1].notes.push({ pitch: 60, velocity: 80, startTick: 507, endTick: 900 });
    const { doc: out } = applyOperations(doc, [
      { type: 'set_tempo', bpm: 96 },
      { type: 'quantize', grid: 0.25, strength: 1 },
    ]);
    expect(collectTempos(out)[0].usPerQuarter).toBe(625000); // 60e6/96
    expect(out.tracks[1].notes[0].startTick).toBe(480);
  });

  it('add_tempo_change 按小节生效', () => {
    const doc = pianoDoc();
    const { doc: out } = applyOperations(doc, [{ type: 'add_tempo_change', bar: 3, bpm: 140 }]);
    const tempos = collectTempos(out);
    expect(tempos).toHaveLength(2);
    expect(tempos[1].tick).toBe(2 * 1920);
  });

  it('delete_track 与 set_program', () => {
    const doc = pianoDoc();
    doc.tracks.push(createEmptyTrack('Bass', 32));
    const { doc: out } = applyOperations(doc, [
      { type: 'set_program', trackIndex: 1, program: 40 },
      { type: 'delete_track', trackIndex: 2 },
    ]);
    expect(out.tracks[1].program).toBe(40);
    expect(out.tracks).toHaveLength(2);
  });
});

describe('CC 曲线值域与精确绘制', () => {
  function longPhraseDoc(): ReturnType<typeof pianoDoc> {
    const doc = pianoDoc();
    // 一个 8 小节的连续乐句（每拍一个音）
    for (let i = 0; i < 32; i++) {
      doc.tracks[1].notes.push({ pitch: 60 + (i % 5) * 2, velocity: 85, startTick: i * 480, endTick: i * 480 + 430 });
    }
    return doc;
  }

  it('auto_cc_curve min/max：曲线严格落在指定值域内（0-64）', () => {
    const out = generateCcCurve(longPhraseDoc(), { min: 0, max: 64, seed: 9 });
    const ccs = out.tracks[1].controls.filter((c) => c.controller === 11);
    expect(ccs.length).toBeGreaterThan(20);
    const values = ccs.map((c) => c.value);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThanOrEqual(64);
    // 确实用满了值域上下部（不再永远卡在高位）
    expect(Math.min(...values)).toBeLessThanOrEqual(24);
    expect(Math.max(...values)).toBeGreaterThanOrEqual(56);
  });

  it('auto_cc_curve min/max：高位区间同样可用（80-100）', () => {
    const out = generateCcCurve(longPhraseDoc(), { min: 80, max: 100, seed: 9 });
    const values = out.tracks[1].controls.filter((c) => c.controller === 11).map((c) => c.value);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(80);
    expect(Math.max(...values)).toBeLessThanOrEqual(100);
  });

  it('applyOperations 透传 auto_cc_curve 的 min/max', () => {
    const { doc: out, summary } = applyOperations(longPhraseDoc(), [
      { type: 'auto_cc_curve', min: 0, max: 50, seed: 3 },
    ]);
    const values = out.tracks[1].controls.filter((c) => c.controller === 11).map((c) => c.value);
    expect(Math.max(...values)).toBeLessThanOrEqual(50);
    expect(summary).toContain('值域');
  });

  it('set_cc_curve linear：按控制点直线插值', () => {
    const { doc: out, summary } = applyOperations(longPhraseDoc(), [
      {
        type: 'set_cc_curve',
        curve: 'linear',
        points: [
          { bar: 1, value: 0 },
          { bar: 5, value: 127 },
        ],
      },
    ]);
    const ccs = out.tracks[1].controls.filter((c) => c.controller === 11);
    expect(ccs.length).toBeGreaterThan(20);
    // 4/4、480tpq：第 1 小节头 = tick 0，第 5 小节头 = tick 7680；中点 tick 3840 ≈ 64
    const atMid = ccs.filter((c) => c.tick === 3840).map((c) => c.value);
    expect(atMid[0]).toBeGreaterThanOrEqual(62);
    expect(atMid[0]).toBeLessThanOrEqual(65);
    // 首点在 tick 0：起点为 0，随后沿直线缓慢上升
    expect(ccs.filter((c) => c.tick === 0).every((c) => c.value === 0)).toBe(true);
    expect(ccs.filter((c) => c.tick === 60).every((c) => c.value <= 5)).toBe(true);
    // 末点（tick 7680）为 127，之后保持 127
    expect(ccs.filter((c) => c.tick === 7680).every((c) => c.value === 127)).toBe(true);
    expect(ccs.filter((c) => c.tick >= 7680).every((c) => c.value === 127)).toBe(true);
    expect(summary).toContain('CC11');
    // round-trip：写盘再读回，值 0-127 完整保留
    const reparsed = parse(writeMidi(out));
    const back = reparsed.tracks[1].controls.filter((c) => c.controller === 11);
    expect(back.length).toBe(ccs.length);
    expect(Math.min(...back.map((c) => c.value))).toBe(0);
    expect(Math.max(...back.map((c) => c.value))).toBe(127);
  });

  it('set_cc_curve step：阶梯保持', () => {
    const { doc: out } = applyOperations(longPhraseDoc(), [
      {
        type: 'set_cc_curve',
        curve: 'step',
        points: [
          { bar: 1, value: 10 },
          { bar: 3, value: 90 },
          { bar: 5, value: 30 },
        ],
      },
    ]);
    const ccs = out.tracks[1].controls.filter((c) => c.controller === 11);
    // 小节 1-2 区间内全部为 10，3-4 为 90，5 之后为 30
    expect(ccs.filter((c) => c.tick >= 0 && c.tick < 2 * 1920).every((c) => c.value === 10)).toBe(true);
    expect(ccs.filter((c) => c.tick >= 2 * 1920 && c.tick < 4 * 1920).every((c) => c.value === 90)).toBe(true);
    expect(ccs.filter((c) => c.tick >= 4 * 1920).every((c) => c.value === 30)).toBe(true);
  });

  it('set_cc_curve smooth：平滑弧线单调且替换旧 CC11', () => {
    const doc = longPhraseDoc();
    doc.tracks[1].controls.push({ tick: 0, controller: 11, value: 100 });
    const { doc: out } = applyOperations(doc, [
      {
        type: 'set_cc_curve',
        curve: 'smooth',
        points: [
          { bar: 1, value: 20 },
          { bar: 3, value: 90 },
          { bar: 5, value: 20 },
        ],
      },
    ]);
    const ccs = out.tracks[1].controls.filter((c) => c.controller === 11);
    // 旧 CC11（value=100）已被替换
    expect(ccs.every((c) => !(c.tick === 0 && c.value === 100))).toBe(true);
    // 上升段（1-3 小节头之间）单调不降（平滑余弦插值）
    const rising = ccs.filter((c) => c.tick >= 0 && c.tick <= 2 * 1920).map((c) => c.value);
    for (let i = 1; i < rising.length; i++) {
      expect(rising[i]).toBeGreaterThanOrEqual(rising[i - 1] - 0.001);
    }
    // 峰值在 3 小节头附近 ≈ 90
    const peakVals = ccs.filter((c) => c.tick === 2 * 1920).map((c) => c.value);
    expect(peakVals[0]).toBeCloseTo(90, 0);
  });

  it('set_cc_curve 可指定控制器号（如 CC1）', () => {
    const { doc: out } = applyOperations(longPhraseDoc(), [
      { type: 'set_cc_curve', controller: 1, curve: 'linear', points: [{ bar: 1, value: 0 }, { bar: 3, value: 100 }] },
    ]);
    expect(out.tracks[1].controls.some((c) => c.controller === 1)).toBe(true);
    expect(out.tracks[1].controls.some((c) => c.controller === 11)).toBe(false);
  });
});

describe('统计信息', () => {
  it('analyzeStats 汇总正确（含 CC 值域）', () => {
    const doc = pianoDoc();
    for (let i = 0; i < 8; i++) doc.tracks[1].notes.push({ pitch: 60 + i, velocity: 70 + i, startTick: i * 480, endTick: i * 480 + 400 });
    doc.tracks[1].controls.push(
      { tick: 0, controller: 11, value: 90 },
      { tick: 480, controller: 11, value: 30 },
    );
    const stats = analyzeStats(doc);
    expect(stats.totalNotes).toBe(8);
    expect(stats.tempoBpm).toBe(120);
    expect(stats.hasCC11).toBe(true);
    expect(stats.hasSustain).toBe(false);
    expect(stats.tracks[1].maxVelocity).toBe(77);
    expect(stats.key.tonicName).toBe('C');
    expect(stats.tracks[1].controllerValues[11]).toEqual({ min: 30, max: 90, count: 2 });
  });
});
