/** WebAudio MIDI 播放器：CC11 表情 / 延音踏板 / 自定义合成器音色 / 实时音量。 */
import { MidiDocument } from '@shared/midi/types';
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
  private lfo: VibratoLfo | null = null;
  private volume = 0.85;
  onEnded: (() => void) | null = null;

  constructor(private getSynth?: () => SynthSettings | null) {}

  get isPlaying(): boolean {
    return this.playing;
  }

  get isPaused(): boolean {
    return this.paused;
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

    // 先确定各轨道音色，决定是否需要全局颤音 LFO
    const trackSynths: SynthSettings[] = this.doc.tracks.map((t) => {
      if (t.channel === 9) return null as unknown as SynthSettings;
      return custom ?? timbreToSynth(timbreOf(t.program, t.channel));
    });
    const vibUser = custom?.vibrato;
    const vibTimbre = trackSynths
      .filter((s): s is SynthSettings => !!s)
      .map((s) => s.vibrato)
      .sort((a, b) => b.depth - a.depth)[0];
    const vib = custom
      ? vibUser && vibUser.depth > 0
        ? vibUser
        : null
      : vibTimbre && vibTimbre.depth > 0
        ? vibTimbre
        : null;
    if (vib) {
      this.lfo = createVibrato(ctx, vib.rate, vib.depth, now);
    }

    this.doc.tracks.forEach((track, trackIndex) => {
      if (track.notes.length === 0 && track.controls.length === 0) return;
      const isDrum = track.channel === 9;

      // 轨道增益 + CC11 表情自动化
      const trackGain = ctx.createGain();
      trackGain.gain.value = 1;
      trackGain.connect(this.chain!.input);

      const cc11 = track.controls.filter((c) => c.controller === 11);
      if (cc11.length > 0) {
        trackGain.gain.value = Math.max(0.05, cc11[0].value / 127);
        for (const c of cc11) {
          const t = now + ticksToSec(c.tick, tpq, tempoMap) - fromSec;
          if (t < now - 0.01) continue;
          trackGain.gain.linearRampToValueAtTime(Math.max(0.03, c.value / 127), Math.max(now, t));
        }
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

      for (const note of track.notes) {
        const s0 = ticksToSec(note.startTick, tpq, tempoMap);
        const s1 = ticksToSec(effectiveEndTick(note), tpq, tempoMap);
        if (s1 <= fromSec) continue; // 在起点之前已结束
        const t0 = Math.max(now, now + (s0 - fromSec));
        const t1 = Math.max(t0 + 0.06, now + (s1 - fromSec));
        const scheduled = isDrum
          ? scheduleDrumHit(ctx, trackGain, note.pitch, note.velocity, t0)
          : scheduleSynthNote(ctx, trackGain, trackSynths[trackIndex], note.pitch, note.velocity, t0, t1, this.lfo?.gain ?? null);
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
    if (this.lfo) {
      try {
        this.lfo.osc.stop(this.ctx!.currentTime + 0.1);
      } catch {
        // ignore
      }
      this.lfo = null;
    }
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
