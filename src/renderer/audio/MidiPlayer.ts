/** WebAudio MIDI 播放器：CC11 表情 / 延音踏板 / 自定义合成器音色 / 实时音量 / 演奏控制器（CC1/2/7/10/67/74）。 */
import { MidiDocument, MidiTrack } from '@shared/midi/types';
import { parseMidi } from '@shared/midi/parser';
import { buildTempoMap, collectTempos, ticksToSec } from '@shared/midi/timing';
import {
  SynthSettings,
  buildMasterChain,
  MasterChain,
  createVibrato,
  VibratoLfo,
  scheduleSynthNote,
  scheduleDrumHit,
  timbreOf,
  timbreToSynth,
} from './synthEngine';

interface ScheduledNote {
  oscs: OscillatorNode[];
  gain: GainNode;
}

export class MidiPlayer {
  private ctx: AudioContext | null = null;
  private chain: MasterChain | null = null;
  private scheduled: ScheduledNote[] = [];
  private doc: MidiDocument | null = null;
  private tempoMapCache: ReturnType<typeof buildTempoMap> | null = null;
  private startCtxTime = 0;
  private startOffset = 0;
  private playing = false;
  private paused = false;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private lfos: VibratoLfo[] = [];
  private bendSources: ConstantSourceNode[] = [];
  private volume = 0.85;
  private mutedTracks = new Set<number>();
  onEnded: (() => void) | null = null;

  constructor(private getSynth?: () => SynthSettings | null) {}

  get isPlaying(): boolean {
    return this.playing;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** 设置静音轨道（原文档轨道索引）；播放中调用后需重新 play 以生效。 */
  setMutedTracks(ids: number[]): void {
    this.mutedTracks = new Set(ids);
  }

  get durationSec(): number {
    return this.doc ? computeDuration(this.doc) : 0;
  }

  load(doc: MidiDocument): void {
    this.stop();
    this.doc = doc;
    this.tempoMapCache = buildTempoMap(collectTempos(doc), doc.ticksPerQuarter);
  }

  static parse(bytes: Uint8Array): MidiDocument {
    return parseMidi(bytes);
  }

  getPosition(): number {
    if (!this.ctx || !this.playing) return this.startOffset;
    return this.startOffset + (this.ctx.currentTime - this.startCtxTime);
  }

  /** 实时调节音量（播放中立即生效，也作为下次播放的音量）。 */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.ctx && this.chain) {
      const t = this.ctx.currentTime;
      this.chain.master.gain.cancelScheduledValues(t);
      this.chain.master.gain.setTargetAtTime(this.volume, t, 0.03);
    }
  }

  async play(fromSec = 0, volume?: number): Promise<void> {
    if (!this.doc) return;
    this.stop();
    if (!this.ctx) this.ctx = new AudioContext();
    await this.ctx.resume();
    const ctx = this.ctx;

    if (volume !== undefined) this.volume = Math.max(0, Math.min(1, volume));
    const custom = this.getSynth?.() ?? null;
    this.chain = buildMasterChain(ctx, this.volume, custom?.eq ?? { low: 0, mid: 0, high: 0 });

    const tpq = this.doc.ticksPerQuarter;
    const tempoMap = this.tempoMapCache ?? buildTempoMap(collectTempos(this.doc), tpq);
    const duration = computeDuration(this.doc);
    const now = ctx.currentTime + 0.08;
    this.startCtxTime = now;
    this.startOffset = fromSec;
    this.playing = true;
    this.paused = false;

    // 各轨道音色（鼓组除外）
    const trackSynths: SynthSettings[] = this.doc.tracks.map((t) => {
      if (t.channel === 9) return null as unknown as SynthSettings;
      return custom ?? timbreToSynth(timbreOf(t.program, t.channel));
    });

    /** 把某控制器的全部事件调度到一个 AudioParam 上（线性逼近），并设置正确的初值。 */
    const scheduleCC = (
      track: MidiTrack,
      controller: number,
      param: AudioParam,
      map: (v: number) => number,
      defaultValue: number,
    ): void => {
      const events = track.controls.filter((c) => c.controller === controller).sort((a, b) => a.tick - b.tick);
      if (events.length === 0) {
        param.value = defaultValue;
        return;
      }
      const past = events.filter((c) => ticksToSec(c.tick, tpq, tempoMap) <= fromSec);
      param.value = past.length > 0 ? map(past[past.length - 1].value) : map(events[0].value);
      for (const c of events) {
        const t = now + ticksToSec(c.tick, tpq, tempoMap) - fromSec;
        if (t <= now + 0.005) continue;
        param.linearRampToValueAtTime(map(c.value), Math.max(now + 0.005, t));
      }
    };

    this.doc.tracks.forEach((track, trackIndex) => {
      if (this.mutedTracks.has(trackIndex)) return; // 静音轨不参与调度
      if (track.notes.length === 0 && track.controls.length === 0) return;
      const isDrum = track.channel === 9;

      // 轨道链：notes → trackGain(CC11 表情) → ccGain(CC7 音量/CC2 气息/CC67 弱音) → panner(CC10) → tilt(CC74 亮度) → 主链
      const trackGain = ctx.createGain();
      const ccGain = ctx.createGain();
      trackGain.connect(ccGain);
      let panner: StereoPannerNode | null = null;
      let tilt: BiquadFilterNode | null = null;
      let tail: AudioNode = ccGain;
      if (!isDrum) {
        panner = ctx.createStereoPanner();
        ccGain.connect(panner);
        tilt = ctx.createBiquadFilter();
        tilt.type = 'lowpass';
        tilt.Q.value = 0.5;
        panner.connect(tilt);
        tail = tilt;
      }
      tail.connect(this.chain!.input);

      // 演奏控制器自动化（线性逼近，起点前的最后一个事件作为初值）
      scheduleCC(track, 11, trackGain.gain, (v) => Math.max(0, v / 127), 1);
      if (panner && tilt) {
        scheduleCC(track, 7, ccGain.gain, (v) => Math.max(0, v / 127), 1);
        scheduleCC(track, 2, ccGain.gain, (v) => Math.max(0.05, v / 127), 1);
        scheduleCC(track, 67, ccGain.gain, (v) => 1 - (v / 127) * 0.4, 1);
        scheduleCC(track, 10, panner.pan, (v) => Math.max(-1, Math.min(1, (v - 64) / 63)), 0);
        scheduleCC(track, 74, tilt.frequency, (v) => 1000 * Math.pow(16, v / 127), 16000);
      }

      // 延音踏板段（CC64）
      const pedalSegments: { start: number; end: number }[] = [];
      {
        let open: number | null = null;
        for (const c of track.controls) {
          if (c.controller !== 64) continue;
          if (c.value >= 64 && open === null) open = c.tick;
          else if (c.value < 64 && open !== null) {
            pedalSegments.push({ start: open, end: c.tick });
            open = null;
          }
        }
        if (open !== null) pedalSegments.push({ start: open, end: Number.MAX_SAFE_INTEGER });
      }
      const effectiveEndTick = (n: { endTick: number }): number => {
        const seg = pedalSegments.find((p) => p.start <= n.endTick && n.endTick < p.end);
        if (seg) return Math.min(seg.end, n.endTick + tpq * 4);
        return n.endTick;
      };

      // 每轨 Pitch Bend：恒流源（音分）→ 每个振荡器的 detune，实时跟随弯音事件
      const synth = trackSynths[trackIndex];
      let vibGain: GainNode | null = null;
      let bendSource: ConstantSourceNode | null = null;
      if (!isDrum && synth) {
        const bends = [...track.pitchBends].sort((a, b) => a.tick - b.tick);
        if (bends.length > 0) {
          bendSource = ctx.createConstantSource();
          bendSource.offset.value = 0;
          this.bendSources.push(bendSource);
          bendSource.start(now);
          const mapBend = (v: number): number => ((v - 8192) / 8192) * 200; // ±2 半音 → ±200 音分
          const past = bends.filter((b) => ticksToSec(b.tick, tpq, tempoMap) <= fromSec);
          bendSource.offset.value = past.length > 0 ? mapBend(past[past.length - 1].value) : mapBend(bends[0].value);
          for (const b of bends) {
            const t = now + ticksToSec(b.tick, tpq, tempoMap) - fromSec;
            if (t <= now + 0.005) continue;
            bendSource.offset.linearRampToValueAtTime(mapBend(b.value), Math.max(now + 0.005, t));
          }
        }

        const cc1 = track.controls.filter((c) => c.controller === 1);
        const baseDepth = synth.vibrato.depth;
        if (baseDepth > 0 || cc1.length > 0) {
          const lfo = createVibrato(ctx, synth.vibrato.rate || 5.5, 0, now);
          this.lfos.push(lfo);
          vibGain = lfo.gain;
          vibGain.gain.value = cc1.length > 0 ? 0 : baseDepth;
          for (const c of cc1) {
            const t = now + ticksToSec(c.tick, tpq, tempoMap) - fromSec;
            if (t <= now + 0.005) {
              vibGain.gain.value = (c.value / 127) * 45;
              continue;
            }
            vibGain.gain.linearRampToValueAtTime((c.value / 127) * 45, Math.max(now + 0.005, t));
          }
        }
      }

      for (const note of track.notes) {
        const s0 = ticksToSec(note.startTick, tpq, tempoMap);
        const s1 = ticksToSec(effectiveEndTick(note), tpq, tempoMap);
        if (s1 <= fromSec) continue; // 在起点之前已结束
        const t0 = Math.max(now, now + (s0 - fromSec));
        const t1 = Math.max(t0 + 0.06, now + (s1 - fromSec));
        const scheduled = isDrum
          ? scheduleDrumHit(ctx, trackGain, note.pitch, note.velocity, t0)
          : scheduleSynthNote(ctx, trackGain, synth, note.pitch, note.velocity, t0, t1, vibGain, bendSource);
        this.scheduled.push(scheduled);
      }
    });

    const remainSec = duration - fromSec;
    if (remainSec > 0) {
      this.endTimer = setTimeout(() => {
        this.stop();
        this.onEnded?.();
      }, remainSec * 1000 + 400);
    } else {
      this.stop();
      this.onEnded?.();
    }
  }

  /** 暂停：挂起 AudioContext（LFO 与调度一同冻结），可无损恢复。 */
  async pause(): Promise<void> {
    if (!this.ctx || !this.playing) return;
    await this.ctx.suspend();
    this.paused = true;
    this.playing = false;
  }

  async resume(): Promise<void> {
    if (!this.ctx || !this.paused) return;
    await this.ctx.resume();
    this.paused = false;
    this.playing = true;
  }

  stop(): void {
    if (this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    if (this.ctx && this.scheduled.length > 0) {
      const now = this.ctx.currentTime;
      for (const note of this.scheduled) {
        try {
          note.gain.gain.cancelScheduledValues(now);
          note.gain.gain.setTargetAtTime(0, now, 0.02);
          for (const osc of note.oscs) osc.stop(now + 0.1);
        } catch {
          // ignore
        }
      }
    }
    this.scheduled = [];
    for (const lfo of this.lfos) {
      try {
        lfo.osc.stop(this.ctx!.currentTime + 0.1);
      } catch {
        // ignore
      }
    }
    this.lfos = [];
    for (const src of this.bendSources) {
      try {
        src.stop(this.ctx!.currentTime + 0.1);
      } catch {
        // ignore
      }
    }
    this.bendSources = [];
    this.playing = false;
    this.paused = false;
    if (this.ctx) {
      void this.ctx.resume().catch(() => undefined);
      this.startOffset = Math.min(this.getPosition(), this.durationSec);
    }
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}

function computeDuration(doc: MidiDocument): number {
  const tpq = doc.ticksPerQuarter;
  const tempoMap = buildTempoMap(collectTempos(doc), tpq);
  let end = 0;
  for (const t of doc.tracks) {
    for (const n of t.notes) end = Math.max(end, n.endTick);
    for (const c of t.controls) end = Math.max(end, c.tick + 1);
  }
  return end > 0 ? ticksToSec(end, tpq, tempoMap) + 0.6 : 0;
}
