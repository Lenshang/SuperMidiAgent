/** 标准 MIDI 文件（SMF）解析器：容错读取，支持 running status、多通道轨道、音符配对。 */
import {
  MidiDocument,
  MidiTrack,
  createEmptyTrack,
  DRUM_CHANNEL,
} from './types';

export class MidiParseError extends Error {}

class Reader {
  offset = 0;

  constructor(readonly data: Uint8Array) {}

  get remaining(): number {
    return this.data.length - this.offset;
  }

  u8(): number {
    if (this.remaining < 1) throw new MidiParseError('文件意外结束');
    return this.data[this.offset++];
  }

  u16(): number {
    return (this.u8() << 8) | this.u8();
  }

  u32(): number {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }

  str(len: number): string {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.u8());
    return s;
  }

  skip(len: number): void {
    if (len < 0 || len > this.remaining) throw new MidiParseError('事件长度越界');
    this.offset += len;
  }

  varlen(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      value = (value << 7) | (b & 0x7f);
      if (!(b & 0x80)) return value;
    }
    return value;
  }
}

interface OpenNote {
  startTick: number;
  velocity: number;
}

/** 解析 SMF 字节为 MidiDocument。解析失败抛出 MidiParseError。 */
export function parseMidi(data: Uint8Array): MidiDocument {
  const r = new Reader(data);
  if (r.remaining < 14 || r.str(4) !== 'MThd') throw new MidiParseError('不是有效的 MIDI 文件（缺少 MThd）');
  const headerLen = r.u32();
  const format = r.u16();
  if (format > 2) throw new MidiParseError(`不支持的 MIDI 格式: ${format}`);
  const ntrks = r.u16();
  const division = r.u16();
  if (division & 0x8000) throw new MidiParseError('不支持 SMPTE 时间格式');
  r.skip(headerLen - 6);

  const tracks: MidiTrack[] = [];
  let trackIndex = 0;
  while (r.remaining >= 8 && trackIndex < ntrks) {
    const chunkType = r.str(4);
    const chunkLen = r.u32();
    if (chunkType === 'MTrk') {
      tracks.push(parseTrack(r, chunkLen));
      trackIndex++;
    } else {
      r.skip(chunkLen); // 未知块，跳过
    }
  }
  if (tracks.length === 0) throw new MidiParseError('文件中没有 MTrk 轨道');

  return { format: format === 0 ? 0 : 1, ticksPerQuarter: division || 480, tracks };
}

function parseTrack(r: Reader, length: number): MidiTrack {
  const end = r.offset + length;
  const track = createEmptyTrack('');
  track.channel = -1;
  const openNotes = new Map<string, OpenNote[]>();
  let runningStatus = -1;
  let tick = 0;
  let maxTick = 0;
  let programSeen = -1;

  const closeNote = (key: string, endTick: number, offVelocity: number): void => {
    const stack = openNotes.get(key);
    if (!stack || stack.length === 0) return;
    const open = stack.pop()!;
    const noteEnd = Math.max(open.startTick + 1, endTick);
    track.notes.push({
      pitch: parseInt(key.slice(3), 10),
      velocity: open.velocity,
      startTick: open.startTick,
      endTick: noteEnd,
      channel: parseInt(key.slice(0, 2), 16),
    });
    void offVelocity;
    maxTick = Math.max(maxTick, noteEnd);
  };

  while (r.offset < end) {
    tick += r.varlen();
    let status = r.u8();
    if (status < 0x80) {
      // running status：复用上一个状态字节，当前字节是第一个数据字节
      if (runningStatus < 0) throw new MidiParseError('running status 出现在状态字节之前');
      r.offset--;
      status = runningStatus;
    } else if (status < 0xf0) {
      runningStatus = status;
    } else {
      runningStatus = -1;
    }

    if (status === 0xff) {
      const type = r.u8();
      const len = r.varlen();
      switch (type) {
        case 0x03: {
          const name = r.str(len);
          if (!track.name) track.name = name;
          break;
        }
        case 0x51: {
          const us = (r.u8() << 16) | (r.u8() << 8) | r.u8();
          track.tempos.push({ tick, usPerQuarter: us || 500000 });
          break;
        }
        case 0x58: {
          const numerator = r.u8();
          const denPow = r.u8();
          r.u8();
          r.u8();
          track.timeSignatures.push({ tick, numerator, denominator: Math.pow(2, denPow) });
          break;
        }
        case 0x2f:
          r.skip(len);
          r.offset = end;
          break;
        default:
          r.skip(len);
      }
      maxTick = Math.max(maxTick, tick);
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const len = r.varlen();
      r.skip(len);
      maxTick = Math.max(maxTick, tick);
      continue;
    }

    const messageType = status & 0xf0;
    const channel = status & 0x0f;
    switch (messageType) {
      case 0x90: {
        const pitch = r.u8();
        const velocity = r.u8();
        const key = `${channel.toString(16).padStart(2, '0')}:${pitch}`;
        if (velocity > 0) {
          const stack = openNotes.get(key) ?? [];
          // 同音重触发：先关闭之前的音
          if (stack.length > 0) closeNote(key, tick, 0);
          stack.push({ startTick: tick, velocity });
          openNotes.set(key, stack);
          if (track.channel < 0) track.channel = channel;
        } else {
          closeNote(key, tick, velocity);
        }
        break;
      }
      case 0x80: {
        const pitch = r.u8();
        r.u8();
        closeNote(`${channel.toString(16).padStart(2, '0')}:${pitch}`, tick, 0);
        break;
      }
      case 0xb0: {
        const controller = r.u8();
        const value = r.u8();
        track.controls.push({ tick, controller, value, channel });
        if (track.channel < 0) track.channel = channel;
        break;
      }
      case 0xe0: {
        const lo = r.u8();
        const hi = r.u8();
        track.pitchBends.push({ tick, value: lo | (hi << 7), channel });
        break;
      }
      case 0xc0: {
        const program = r.u8();
        if (programSeen < 0) {
          programSeen = program;
          track.program = program;
        }
        if (track.channel < 0) track.channel = channel;
        break;
      }
      case 0xd0:
        r.u8();
        break;
      case 0xa0:
        r.u8();
        r.u8();
        break;
      default:
        throw new MidiParseError(`未知的状态字节 0x${status.toString(16)}`);
    }
    maxTick = Math.max(maxTick, tick);
  }

  // 未配对的 note-on：在轨道末尾闭合
  for (const [key, stack] of openNotes) {
    while (stack.length > 0) closeNote(key, Math.max(maxTick, tick), 0);
  }

  track.notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
  track.controls.sort((a, b) => a.tick - b.tick || a.controller - b.controller);
  track.pitchBends.sort((a, b) => a.tick - b.tick);
  return track;
}

/** 便捷：判断是否是鼓组通道的音符 */
export function isDrumNote(note: { channel?: number }, track: MidiTrack): boolean {
  const ch = note.channel ?? track.channel;
  return ch === DRUM_CHANNEL;
}
