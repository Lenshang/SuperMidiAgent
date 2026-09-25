import { describe, expect, it } from 'vitest';
import { parseMidi } from '../src/shared/midi/parser';
import { writeMidi } from '../src/shared/midi/writer';
import { createEmptyDocument, createEmptyTrack, DEFAULT_US_PER_QUARTER } from '../src/shared/midi/types';
import { formatPitch, parseNoteName } from '../src/shared/midi/notes';

function roundTrip(doc: ReturnType<typeof createEmptyDocument>) {
  const bytes = writeMidi(doc);
  return parseMidi(bytes);
}

describe('音名转换', () => {
  it('解析常见音名', () => {
    expect(parseNoteName('C4')).toBe(60);
    expect(parseNoteName('c4')).toBe(60);
    expect(parseNoteName('F#3')).toBe(54);
    expect(parseNoteName('Bb2')).toBe(46);
    expect(parseNoteName('A0')).toBe(21);
    expect(parseNoteName('G9')).toBe(127);
  });

  it('非法音名报错', () => {
    expect(() => parseNoteName('H4')).toThrow();
    expect(() => parseNoteName('C')).toThrow();
    expect(() => parseNoteName('C129')).toThrow();
  });

  it('格式化音高', () => {
    expect(formatPitch(60)).toBe('C4');
    expect(formatPitch(54)).toBe('F#3');
    expect(formatPitch(46, true)).toBe('Bb2');
    expect(formatPitch(127)).toBe('G9');
  });
});

describe('SMF 写入与解析 round-trip', () => {
  it('单轨道音符', () => {
    const doc = createEmptyDocument(480);
    const track = createEmptyTrack('Melody', 0);
    track.notes.push(
      { pitch: 60, velocity: 90, startTick: 0, endTick: 480 },
      { pitch: 64, velocity: 80, startTick: 480, endTick: 960 },
      { pitch: 67, velocity: 100, startTick: 960, endTick: 1440 },
    );
    doc.tracks.push(track);
    const parsed = roundTrip(doc);
    expect(parsed.format).toBe(1);
    expect(parsed.ticksPerQuarter).toBe(480);
    const melody = parsed.tracks[1];
    expect(melody.name).toBe('Melody');
    expect(melody.notes).toHaveLength(3);
    expect(melody.notes[0]).toMatchObject({ pitch: 60, velocity: 90, startTick: 0, endTick: 480 });
    expect(melody.notes[2]).toMatchObject({ pitch: 67, velocity: 100, startTick: 960, endTick: 1440 });
    expect(melody.program).toBe(0);
  });

  it('CC / 弯音 / 音色', () => {
    const doc = createEmptyDocument(480);
    const track = createEmptyTrack('Expr', 48);
    track.channel = 3;
    track.notes.push({ pitch: 72, velocity: 64, startTick: 0, endTick: 960 });
    track.controls.push(
      { tick: 0, controller: 11, value: 40 },
      { tick: 240, controller: 11, value: 100 },
      { tick: 480, controller: 64, value: 127 },
    );
    track.pitchBends.push({ tick: 120, value: 8192 + 2000 });
    doc.tracks.push(track);
    const parsed = roundTrip(doc);
    const t = parsed.tracks[1];
    expect(t.channel).toBe(3);
    expect(t.program).toBe(48);
    expect(t.controls).toHaveLength(3);
    expect(t.controls[1]).toMatchObject({ tick: 240, controller: 11, value: 100 });
    expect(t.controls[2]).toMatchObject({ controller: 64, value: 127 });
    expect(t.pitchBends[0].value).toBe(10192);
  });

  it('速度与拍号事件', () => {
    const doc = createEmptyDocument(960);
    doc.tracks[0].tempos = [
      { tick: 0, usPerQuarter: 500000 },
      { tick: 1920, usPerQuarter: 375000 }, // 160bpm
    ];
    doc.tracks[0].timeSignatures = [
      { tick: 0, numerator: 4, denominator: 4 },
      { tick: 3840, numerator: 3, denominator: 4 },
    ];
    const track = createEmptyTrack('N', 0);
    track.notes.push({ pitch: 60, velocity: 80, startTick: 0, endTick: 100 });
    doc.tracks.push(track);
    const parsed = roundTrip(doc);
    expect(parsed.ticksPerQuarter).toBe(960);
    expect(parsed.tracks[0].tempos).toHaveLength(2);
    expect(parsed.tracks[0].tempos[1].usPerQuarter).toBe(375000);
    expect(parsed.tracks[0].timeSignatures[1]).toMatchObject({ numerator: 3, denominator: 4 });
  });

  it('format 0 单轨多通道', () => {
    const doc = createEmptyDocument(480);
    doc.format = 0;
    const track = createEmptyTrack('All', 0);
    track.channel = -1;
    track.notes.push(
      { pitch: 60, velocity: 90, startTick: 0, endTick: 480, channel: 0 },
      { pitch: 36, velocity: 100, startTick: 0, endTick: 120, channel: 9 },
    );
    doc.tracks = [track];
    const bytes = writeMidi(doc);
    const parsed = parseMidi(bytes);
    expect(parsed.format).toBe(0);
    expect(parsed.tracks).toHaveLength(1);
    expect(parsed.tracks[0].notes).toHaveLength(2);
    const drums = parsed.tracks[0].notes.find((n) => n.channel === 9);
    expect(drums?.pitch).toBe(36);
  });

  it('同音重触发与未闭合音符', () => {
    // 手工构造：note-on 60, note-on 60（未 off）, note-off 60, end —— 解析器应容错
    const bytes = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0x01, 0xe0, // MThd format1 1track 480
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 22, // MTrk len 22
      0x00, 0x90, 60, 64, // t0 note on 60
      0x60, 0x90, 60, 70, // t96 重触发 60
      0x60, 0x80, 60, 0, // t96 off
      0x60, 0x80, 60, 0, // t96 off (多余)
      0x00, 0xff, 0x2f, 0x00,
    ]);
    const parsed = parseMidi(bytes);
    const notes = parsed.tracks[0].notes;
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ pitch: 60, startTick: 0, endTick: 96, velocity: 64 });
    expect(notes[1]).toMatchObject({ pitch: 60, startTick: 96, endTick: 192, velocity: 70 });
  });

  it('大文件 round-trip 稳定（500+ 音符、双轨）', () => {
    const doc = createEmptyDocument(480);
    for (let ti = 0; ti < 2; ti++) {
      const track = createEmptyTrack(`T${ti}`, ti * 20);
      for (let i = 0; i < 300; i++) {
        track.notes.push({
          pitch: 36 + ((i * 7 + ti * 3) % 60),
          velocity: 40 + (i % 80),
          startTick: i * 120,
          endTick: i * 120 + 100,
        });
      }
      for (let i = 0; i < 50; i++) {
        track.controls.push({ tick: i * 480, controller: 11, value: (i * 9) % 128 });
      }
      doc.tracks.push(track);
    }
    const parsed = roundTrip(doc);
    expect(parsed.tracks[1].notes).toHaveLength(300);
    expect(parsed.tracks[2].notes).toHaveLength(300);
    expect(parsed.tracks[1].controls).toHaveLength(50);
    // 全部音符还原一致
    const orig = doc.tracks[1].notes;
    const back = parsed.tracks[1].notes;
    expect(back.map((n) => [n.pitch, n.velocity, n.startTick, n.endTick])).toEqual(
      orig.map((n) => [n.pitch, n.velocity, n.startTick, n.endTick]),
    );
  });

  it('默认速度事件在无速度轨道时写入', () => {
    const doc = createEmptyDocument(480);
    doc.tracks[0].tempos = [];
    doc.tracks[0].timeSignatures = [];
    const bytes = writeMidi(doc);
    const parsed = parseMidi(bytes);
    expect(parsed.tracks[0].tempos[0].usPerQuarter).toBe(DEFAULT_US_PER_QUARTER);
    expect(parsed.tracks[0].timeSignatures[0]).toMatchObject({ numerator: 4, denominator: 4 });
  });
});

describe('解析容错', () => {
  it('非 MIDI 文件抛错', () => {
    expect(() => parseMidi(Uint8Array.from([1, 2, 3, 4]))).toThrow();
    const text = new TextEncoder().encode('hello world this is not midi at all.........');
    expect(() => parseMidi(text)).toThrow();
  });

  it('running status 解析', () => {
    // 第二个 note-on 使用 running status（省略 0x90）
    const bytes = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0,
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 15,
      0x00, 0x90, 60, 64,
      0x50, 64, 70, // delta + running status + pitch + vel
      0x50, 60, 0, // delta + running(0x90) + 60 + vel0 => off
      0x00, 0xff, 0x2f, 0x00,
    ]);
    const parsed = parseMidi(bytes);
    const notes = parsed.tracks[0].notes;
    expect(notes).toHaveLength(2);
    expect(notes[1]).toMatchObject({ pitch: 64, startTick: 80, endTick: 160 });
  });
});
