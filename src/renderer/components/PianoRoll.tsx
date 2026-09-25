/** Canvas 钢琴卷帘：音符 + 小节网格 + CC11 叠加 + 播放指针。 */
import { useEffect, useMemo, useRef } from 'react';
import { MidiDocument } from '@shared/midi/types';
import { buildSigMap, collectSigs, collectTempos, buildTempoMap, ticksToSec, barToTick } from '@shared/midi/timing';

const TRACK_COLORS = ['#7c5cff', '#00c2a8', '#ff7a59', '#f5b940', '#4aa8ff', '#e569c8', '#8fd14f', '#ff5c7a'];

interface Props {
  doc: MidiDocument;
  durationSec: number;
  positionSec: number;
  height?: number;
  showCC11?: boolean;
}

export default function PianoRoll({ doc, durationSec, positionSec, height = 150, showCC11 = true }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const layout = useMemo(() => {
    const notes = doc.tracks.flatMap((t, ti) => t.notes.map((n) => ({ ...n, ti })));
    if (notes.length === 0) return null;
    let minPitch = Math.min(...notes.map((n) => n.pitch));
    let maxPitch = Math.max(...notes.map((n) => n.pitch));
    minPitch = Math.max(0, minPitch - 2);
    maxPitch = Math.min(127, maxPitch + 2);
    return { notes, minPitch, maxPitch };
  }, [doc]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout || durationSec <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    // 背景
    ctx.fillStyle = '#191926';
    ctx.fillRect(0, 0, width, height);

    const tpq = doc.ticksPerQuarter;
    const tempoMap = buildTempoMap(collectTempos(doc), tpq);
    const sigMap = buildSigMap(collectSigs(doc));
    const endTick = Math.ceil((durationSec * tpq) / (tempoMap[0]?.usPerQuarter / 1e6) / tpq) * tpq + tpq;

    const xOf = (sec: number) => (sec / durationSec) * (width - 8) + 4;
    const yOf = (pitch: number) => height - 6 - ((pitch - layout.minPitch) / Math.max(1, layout.maxPitch - layout.minPitch)) * (height - 24);

    // 小节网格
    const totalBars = Math.max(1, Math.ceil((endTick / tpq / 4) * 10) / 10);
    for (let bar = 1; bar <= Math.ceil(totalBars) + 1; bar++) {
      const tick = barToTick(bar, tpq, sigMap);
      const sec = ticksToSec(tick, tpq, tempoMap);
      if (sec > durationSec) break;
      const x = xOf(sec);
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      ctx.font = '9px sans-serif';
      ctx.fillText(String(bar), x + 2, 9);
    }

    // 黑键行底色（可选装饰）
    ctx.globalAlpha = 1;

    // 音符
    for (const note of layout.notes) {
      const s0 = ticksToSec(note.startTick, tpq, tempoMap);
      const s1 = ticksToSec(note.endTick, tpq, tempoMap);
      const x = xOf(s0);
      const w = Math.max(2.5, xOf(s1) - x);
      const y = yOf(note.pitch);
      const h = Math.max(3.2, (height - 24) / Math.max(1, layout.maxPitch - layout.minPitch) - 1.2);
      const color = TRACK_COLORS[note.ti % TRACK_COLORS.length];
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.45 + (note.velocity / 127) * 0.55;
      roundRect(ctx, x, y - h / 2, w, h, 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // CC11 叠加
    if (showCC11) {
      for (const track of doc.tracks) {
        const ccs = track.controls.filter((c) => c.controller === 11);
        if (ccs.length < 2) continue;
        ctx.strokeStyle = 'rgba(255, 214, 102, 0.75)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ccs.forEach((c, i) => {
          const x = xOf(ticksToSec(c.tick, tpq, tempoMap));
          const y = height - 2 - (c.value / 127) * 14;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    // 播放指针
    if (positionSec >= 0) {
      const x = xOf(Math.min(positionSec, durationSec));
      ctx.strokeStyle = '#ff5c7a';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.fillStyle = '#ff5c7a';
      ctx.beginPath();
      ctx.arc(x, 4, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1;
    }
  }, [doc, durationSec, positionSec, height, layout, showCC11]);

  return <canvas ref={canvasRef} style={{ width: '100%', height, borderRadius: 8, display: 'block' }} data-testid="piano-roll" />;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
