/**
 * 合成器引擎：双振荡器 + ADSR + 低通滤波器（含亮度包络）+ 三段 EQ + 颤音 LFO。
 * 自定义音色与内置 GM 音色映射统一走同一调度路径。
 */

export type WaveType = 'sine' | 'square' | 'sawtooth' | 'triangle';

export interface SynthSettings {
  osc1: { wave: WaveType; octave: number; level: number };
  osc2: { wave: WaveType; octave: number; level: number; detune: number }; // detune: 音分
  adsr: { attack: number; decay: number; sustain: number; release: number }; // 秒/0-1/秒
  filter: { cutoff: number; q: number; env: number }; // cutoff Hz, Q 0-12, env 八度数（起音时从低处打开）
  eq: { low: number; mid: number; high: number }; // dB -12..12
  vibrato: { rate: number; depth: number }; // Hz / 音分
  volume: number; // 0-1
}

export const DEFAULT_SYNTH: SynthSettings = {
  osc1: { wave: 'triangle', octave: 0, level: 0.8 },
  osc2: { wave: 'sine', octave: 0, level: 0.35, detune: 6 },
  adsr: { attack: 0.006, decay: 0.6, sustain: 0.45, release: 0.35 },
  filter: { cutoff: 2600, q: 0.8, env: 1.0 },
  eq: { low: 0, mid: 0, high: 0 },
  vibrato: { rate: 5, depth: 0 },
  volume: 0.55,
};

/** 内置预设（"捏音色"的起点）。 */
export const SYNTH_PRESETS: { name: string; settings: SynthSettings }[] = [
  {
    name: '温暖钢琴',
    settings: {
      osc1: { wave: 'triangle', octave: 0, level: 0.85 },
      osc2: { wave: 'sine', octave: 0, level: 0.4, detune: 5 },
      adsr: { attack: 0.004, decay: 0.9, sustain: 0.22, release: 0.45 },
      filter: { cutoff: 2600, q: 0.7, env: 1.4 },
      eq: { low: 1, mid: 0, high: -1 },
      vibrato: { rate: 5, depth: 0 },
      volume: 0.58,
    },
  },
  {
    name: '梦幻长垫',
    settings: {
      osc1: { wave: 'sawtooth', octave: 0, level: 0.5 },
      osc2: { wave: 'sawtooth', octave: 0, level: 0.5, detune: 12 },
      adsr: { attack: 0.45, decay: 0.8, sustain: 0.85, release: 1.2 },
      filter: { cutoff: 1500, q: 1.2, env: 0.4 },
      eq: { low: 1.5, mid: -1, high: 1 },
      vibrato: { rate: 4.2, depth: 7 },
      volume: 0.34,
    },
  },
  {
    name: '电子主音',
    settings: {
      osc1: { wave: 'square', octave: 0, level: 0.5 },
      osc2: { wave: 'sawtooth', octave: 0, level: 0.42, detune: 9 },
      adsr: { attack: 0.012, decay: 0.25, sustain: 0.7, release: 0.22 },
      filter: { cutoff: 3600, q: 2.2, env: 0.6 },
      eq: { low: -1, mid: 1, high: 1.5 },
      vibrato: { rate: 5.5, depth: 16 },
      volume: 0.4,
    },
  },
  {
    name: '弹拨拨弦',
    settings: {
      osc1: { wave: 'triangle', octave: 0, level: 0.8 },
      osc2: { wave: 'sine', octave: 1, level: 0.2, detune: 3 },
      adsr: { attack: 0.002, decay: 0.3, sustain: 0.02, release: 0.2 },
      filter: { cutoff: 2400, q: 1.0, env: 2.2 },
      eq: { low: 0, mid: 1, high: 0 },
      vibrato: { rate: 5, depth: 0 },
      volume: 0.55,
    },
  },
  {
    name: '合成贝斯',
    settings: {
      osc1: { wave: 'sawtooth', octave: -1, level: 0.8 },
      osc2: { wave: 'sine', octave: -1, level: 0.5, detune: 0 },
      adsr: { attack: 0.005, decay: 0.35, sustain: 0.42, release: 0.18 },
      filter: { cutoff: 950, q: 2.5, env: 1.5 },
      eq: { low: 3, mid: 0, high: -2 },
      vibrato: { rate: 5, depth: 0 },
      volume: 0.6,
    },
  },
  {
    name: '弦乐合奏',
    settings: {
      osc1: { wave: 'sawtooth', octave: 0, level: 0.48 },
      osc2: { wave: 'sawtooth', octave: 0, level: 0.48, detune: -9 },
      adsr: { attack: 0.1, decay: 0.4, sustain: 0.85, release: 0.45 },
      filter: { cutoff: 2800, q: 0.7, env: 0.5 },
      eq: { low: 1, mid: -0.5, high: 1 },
      vibrato: { rate: 4.8, depth: 9 },
      volume: 0.36,
    },
  },
];

// ============ GM 音色 → 合成器参数（让内置音色同样受益于双振荡器/滤波包络） ============

export type Timbre = 'piano' | 'epiano' | 'bell' | 'guitar' | 'bass' | 'strings' | 'pad' | 'winds' | 'lead' | 'drum';

export function timbreOf(program: number, channel: number): Timbre {
  if (channel === 9) return 'drum';
  if (program <= 7) return 'piano';
  if (program <= 15) return 'bell';
  if (program <= 23) return 'epiano';
  if (program <= 31) return 'guitar';
  if (program <= 39) return 'bass';
  if (program <= 47) return 'strings';
  if (program <= 55) return 'strings';
  if (program <= 63) return 'pad';
  if (program <= 79) return 'winds';
  if (program <= 87) return 'lead';
  return 'pad';
}

export function timbreToSynth(timbre: Timbre): SynthSettings {
  switch (timbre) {
    case 'piano':
      return { osc1: { wave: 'triangle', octave: 0, level: 0.8 }, osc2: { wave: 'sine', octave: 0, level: 0.4, detune: 5 }, adsr: { attack: 0.004, decay: 0.9, sustain: 0.2, release: 0.4 }, filter: { cutoff: 2400, q: 0.7, env: 1.4 }, eq: { low: 0, mid: 0, high: 0 }, vibrato: { rate: 5, depth: 0 }, volume: 0.58 };
    case 'epiano':
      return { osc1: { wave: 'sine', octave: 0, level: 0.9 }, osc2: { wave: 'triangle', octave: 0, level: 0.3, detune: 6 }, adsr: { attack: 0.006, decay: 0.8, sustain: 0.3, release: 0.35 }, filter: { cutoff: 1900, q: 0.7, env: 0.7 }, eq: { low: 0, mid: 0, high: 0 }, vibrato: { rate: 5, depth: 0 }, volume: 0.52 };
    case 'bell':
      return { osc1: { wave: 'sine', octave: 0, level: 0.8 }, osc2: { wave: 'sine', octave: 1, level: 0.22, detune: 3 }, adsr: { attack: 0.004, decay: 1.2, sustain: 0.05, release: 0.8 }, filter: { cutoff: 3200, q: 0.6, env: 0.8 }, eq: { low: 0, mid: 0, high: 0 }, vibrato: { rate: 5, depth: 0 }, volume: 0.46 };
    case 'guitar':
      return { osc1: { wave: 'sawtooth', octave: 0, level: 0.5 }, osc2: { wave: 'triangle', octave: 0, level: 0.4, detune: 6 }, adsr: { attack: 0.004, decay: 0.6, sustain: 0.28, release: 0.22 }, filter: { cutoff: 2000, q: 0.8, env: 1.2 }, eq: { low: 0, mid: 0, high: 0 }, vibrato: { rate: 5, depth: 0 }, volume: 0.48 };
    case 'bass':
      return { osc1: { wave: 'sawtooth', octave: -1, level: 0.75 }, osc2: { wave: 'sine', octave: -1, level: 0.5, detune: 0 }, adsr: { attack: 0.006, decay: 0.4, sustain: 0.45, release: 0.18 }, filter: { cutoff: 950, q: 2, env: 1.4 }, eq: { low: 0, mid: 0, high: 0 }, vibrato: { rate: 5, depth: 0 }, volume: 0.6 };
    case 'strings':
      return { osc1: { wave: 'sawtooth', octave: 0, level: 0.45 }, osc2: { wave: 'sawtooth', octave: 0, level: 0.45, detune: -8 }, adsr: { attack: 0.09, decay: 0.4, sustain: 0.85, release: 0.4 }, filter: { cutoff: 2600, q: 0.7, env: 0.4 }, eq: { low: 0, mid: 0, high: 0 }, vibrato: { rate: 4.8, depth: 8 }, volume: 0.36 };
    case 'pad':
      return { osc1: { wave: 'sawtooth', octave: 0, level: 0.4 }, osc2: { wave: 'sawtooth', octave: 0, level: 0.4, detune: 10 }, adsr: { attack: 0.28, decay: 0.6, sustain: 0.9, release: 0.8 }, filter: { cutoff: 1700, q: 0.8, env: 0.2 }, eq: { low: 0, mid: 0, high: 0 }, vibrato: { rate: 4.5, depth: 5 }, volume: 0.34 };
    case 'winds':
      return { osc1: { wave: 'triangle', octave: 0, level: 0.75 }, osc2: { wave: 'sine', octave: 0, level: 0.35, detune: 5 }, adsr: { attack: 0.07, decay: 0.3, sustain: 0.8, release: 0.2 }, filter: { cutoff: 2400, q: 0.7, env: 0.2 }, eq: { low: 0, mid: 0, high: 0 }, vibrato: { rate: 5, depth: 0 }, volume: 0.44 };
    case 'lead':
      return { osc1: { wave: 'square', octave: 0, level: 0.4 }, osc2: { wave: 'sawtooth', octave: 0, level: 0.35, detune: 8 }, adsr: { attack: 0.012, decay: 0.25, sustain: 0.7, release: 0.2 }, filter: { cutoff: 3200, q: 1.5, env: 0.4 }, eq: { low: 0, mid: 0, high: 0 }, vibrato: { rate: 5.5, depth: 14 }, volume: 0.4 };
    default:
      return DEFAULT_SYNTH;
  }
}

// ============ 调度 ============

export interface MasterChain {
  input: GainNode; // 音符汇入点
  master: GainNode; // 用户音量（可实时调节）
  nodes: AudioNode[];
}

export function buildMasterChain(ctx: AudioContext, volume: number, eq: SynthSettings['eq']): MasterChain {
  const master = ctx.createGain();
  master.gain.value = volume;

  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 260;
  low.gain.value = eq.low;
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 1400;
  mid.Q.value = 1;
  mid.gain.value = eq.mid;
  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 5200;
  high.gain.value = eq.high;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.ratio.value = 6;

  master.connect(low);
  low.connect(mid);
  mid.connect(high);
  high.connect(comp);
  comp.connect(ctx.destination);
  return { input: master, master, nodes: [low, mid, high, comp] };
}

export interface VibratoLfo {
  osc: OscillatorNode;
  gain: GainNode;
}

export function createVibrato(ctx: AudioContext, rate: number, depth: number, startAt: number): VibratoLfo {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = rate;
  const gain = ctx.createGain();
  gain.gain.value = depth;
  osc.connect(gain);
  osc.start(startAt);
  return { osc, gain };
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/**
 * 调度一个合成音符（双振荡器 → 滤波器 → ADSR 增益 → dest）。
 * 返回节点列表供调用方在 stop 时清理。
 */
export function scheduleSynthNote(
  ctx: AudioContext,
  dest: AudioNode,
  synth: SynthSettings,
  pitch: number,
  velocity: number,
  t0: number,
  t1: number,
  vibrato?: GainNode | null,
): { oscs: OscillatorNode[]; gain: GainNode } {
  const freq = clamp(440 * Math.pow(2, (pitch - 69) / 12), 20, 8000);
  const vel = clamp(velocity / 127, 0.02, 1);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = clamp(synth.filter.q, 0, 20);

  const noteGain = ctx.createGain();
  filter.connect(noteGain);
  noteGain.connect(dest);

  // 振荡器（电平归一化防爆音）
  const oscs: OscillatorNode[] = [];
  const levelSum = Math.max(0.3, synth.osc1.level + synth.osc2.level);
  const norm = 1 / levelSum;
  const mkOsc = (wave: WaveType, octave: number, level: number, detune: number): void => {
    if (level <= 0.001) return;
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.value = clamp(freq * Math.pow(2, octave), 20, 12000);
    osc.detune.value = detune;
    if (vibrato) vibrato.connect(osc.detune);
    const g = ctx.createGain();
    g.gain.value = level * norm;
    osc.connect(g);
    g.connect(filter);
    osc.start(t0);
    oscs.push(osc);
  };
  mkOsc(synth.osc1.wave, synth.osc1.octave, synth.osc1.level, 0);
  mkOsc(synth.osc2.wave, synth.osc2.octave, synth.osc2.level, synth.osc2.detune);

  // 包络时间轴
  const { attack: a, decay: d, sustain: s, release: r } = synth.adsr;
  const atk = Math.max(0.002, a);
  const dec = Math.max(0.02, d);
  const rel = Math.max(0.03, r);
  const dur = Math.max(0.08, t1 - t0);
  const decayEnd = t0 + Math.min(atk + dec, Math.max(atk + 0.02, dur * 0.85));
  const relStart = Math.max(t1, decayEnd);
  const susLevel = clamp(s, 0, 1);

  const peak = vel * clamp(synth.volume, 0.02, 1);
  const sus = Math.max(0.0002, peak * susLevel);
  const g = noteGain.gain;
  g.setValueAtTime(0.0001, t0);
  g.linearRampToValueAtTime(Math.max(0.0002, peak), t0 + atk);
  g.linearRampToValueAtTime(sus, decayEnd);
  g.setValueAtTime(sus, relStart);
  g.exponentialRampToValueAtTime(0.0002, relStart + rel);

  // 滤波器亮度包络：从低处打开到 cutoff，释放时收回
  const velF = 0.55 + 0.45 * vel;
  const base = clamp(synth.filter.cutoff * velF, 60, 15000);
  const envOct = clamp(synth.filter.env, 0, 4);
  const fStart = clamp(base * Math.pow(2, -envOct), 40, 15000);
  const f = filter.frequency;
  f.setValueAtTime(fStart, t0);
  f.exponentialRampToValueAtTime(base, decayEnd);
  f.setValueAtTime(base, relStart);
  f.exponentialRampToValueAtTime(Math.max(40, fStart), relStart + rel * 0.8);

  for (const osc of oscs) osc.stop(relStart + rel + 0.05);
  return { oscs, gain: noteGain };
}

/** 鼓组合成（GM 通道 10）：36 底鼓 / 38 军鼓 / 其余镲片与通鼓。 */
export function scheduleDrumHit(ctx: AudioContext, dest: AudioNode, pitch: number, velocity: number, t0: number): { oscs: OscillatorNode[]; gain: GainNode } {
  const vel = velocity / 127;
  const dur = pitch === 36 ? 0.28 : pitch === 38 ? 0.18 : 0.3;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vel * (pitch === 36 ? 0.9 : pitch === 38 ? 0.55 : 0.28), t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  gain.connect(dest);

  const osc = ctx.createOscillator();
  if (pitch === 36) {
    osc.frequency.setValueAtTime(140, t0);
    osc.frequency.exponentialRampToValueAtTime(46, t0 + 0.12);
  } else if (pitch === 38) {
    osc.frequency.setValueAtTime(196, t0);
    osc.frequency.exponentialRampToValueAtTime(120, t0 + 0.1);
  } else {
    osc.type = 'square';
    osc.frequency.value = 600 + (pitch % 12) * 60;
  }
  osc.connect(gain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
  return { oscs: [osc], gain };
}

// ============ 试听（音色编辑器预览） ============

let previewCtx: AudioContext | null = null;
const previewNodes: { oscs: OscillatorNode[]; gain: GainNode }[] = [];
let previewChain: MasterChain | null = null;
let previewLfo: VibratoLfo | null = null;

export function stopPreview(): void {
  if (!previewCtx) return;
  const now = previewCtx.currentTime;
  for (const n of previewNodes) {
    try {
      n.gain.gain.cancelScheduledValues(now);
      n.gain.gain.setTargetAtTime(0, now, 0.02);
      for (const osc of n.oscs) osc.stop(now + 0.1);
    } catch {
      // ignore
    }
  }
  previewNodes.length = 0;
}

/** 播放一小段琶音试听当前音色。 */
export function playPreview(synth: SynthSettings): void {
  if (!previewCtx) previewCtx = new AudioContext();
  stopPreview();
  const ctx = previewCtx;
  void ctx.resume();
  const t0 = ctx.currentTime + 0.06;

  previewChain = buildMasterChain(ctx, 0.9, synth.eq);
  previewLfo = synth.vibrato.depth > 0 ? createVibrato(ctx, synth.vibrato.rate, synth.vibrato.depth, t0) : null;

  const pitches = [72, 76, 79, 84, 79, 76];
  pitches.forEach((p, i) => {
    const start = t0 + i * 0.17;
    const end = start + 0.42;
    const n = scheduleSynthNote(ctx, previewChain!.input, synth, p, 95, start, end, previewLfo?.gain ?? null);
    previewNodes.push(n);
  });
}

export function closePreview(): void {
  stopPreview();
  void previewCtx?.close().catch(() => undefined);
  previewCtx = null;
  previewChain = null;
  previewLfo = null;
}
