/** MIDI 卡片：钢琴卷帘 + 播放/进度 + 分轨试听/下载/拖拽 + 下载 + 拖拽导出到桌面 + 引用到输入框。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Progress, Slider, Space, Tag, Tooltip, App } from 'antd';
import {
  CaretRightOutlined, PauseOutlined, DownloadOutlined, DragOutlined, ReloadOutlined, MessageOutlined, SoundOutlined, SlidersOutlined,
} from '@ant-design/icons';
import { MidiAssetMeta } from '@shared/types';
import { MidiDocument } from '@shared/midi/types';
import { buildTempoMap, collectTempos, ticksToSec } from '@shared/midi/timing';
import { MidiPlayer } from '../audio/MidiPlayer';
import PianoRoll, { TRACK_COLORS } from './PianoRoll';
import { useAppStore } from '../store';

interface Props {
  midiId: string;
  meta?: MidiAssetMeta;
}

const SOURCE_LABEL: Record<string, string> = { generated: '生成', uploaded: '上传', modified: '修改版' };

export default function MidiCard({ midiId, meta: metaProp }: Props): JSX.Element {
  const { message } = App.useApp();
  const asset = useAppStore((s) => s.assets[midiId]);
  const meta = metaProp ?? asset;
  const playVolume = useAppStore((s) => s.playVolume);
  const setPlayVolume = useAppStore((s) => s.setPlayVolume);
  const setSynthOpen = useAppStore((s) => s.setSynthOpen);

  const [doc, setDoc] = useState<MidiDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [muted, setMuted] = useState<Set<number>>(new Set());
  const playerRef = useRef<MidiPlayer | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (await window.api.midiGet(midiId)) as { meta: MidiAssetMeta; base64: string } | null;
        if (!res) {
          setError('MIDI 数据不存在');
          return;
        }
        const bytes = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
        const parsed = MidiPlayer.parse(bytes);
        if (!cancelled) {
          setDoc(parsed);
          setMuted(new Set());
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      playerRef.current?.dispose();
      playerRef.current = null;
    };
  }, [midiId]);

  const noteTracks = useMemo(
    () => (doc ? doc.tracks.map((t, index) => ({ track: t, index })).filter((x) => x.track.notes.length > 0) : []),
    [doc],
  );

  const duration = useMemo(() => (doc ? computeDur(doc) : 0), [doc]);

  // 卷帘叠加显示的 CC：优先 CC11，否则选事件最多的非踏板 CC（如 CC1/CC74）
  const ccDisplay = useMemo(() => {
    if (!doc) return 11;
    const count: Record<number, number> = {};
    for (const t of doc.tracks) {
      for (const c of t.controls) {
        if (c.controller === 64) continue;
        count[c.controller] = (count[c.controller] ?? 0) + 1;
      }
    }
    if (count[11]) return 11;
    const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
    return best ? Number(best[0]) : 11;
  }, [doc]);

  const ensurePlayer = (): MidiPlayer => {
    if (!playerRef.current) {
      playerRef.current = new MidiPlayer(() => {
        const st = useAppStore.getState();
        return st.synthEnabled ? st.synth : null;
      });
      playerRef.current.onEnded = () => {
        setPlaying(false);
        setPosition(0);
      };
    }
    return playerRef.current;
  };

  const togglePlay = async (): Promise<void> => {
    if (!doc) return;
    const player = ensurePlayer();
    if (player.isPlaying) {
      await player.pause();
      setPlaying(false);
      setPosition(player.getPosition());
      return;
    }
    if (player.isPaused) {
      await player.resume();
      setPlaying(true);
      return;
    }
    player.load(doc);
    await player.play(position >= duration - 0.05 ? 0 : position, playVolume);
    setPlaying(true);
  };

  const restart = (): void => {
    playerRef.current?.stop();
    setPlaying(false);
    setPosition(0);
  };

  const changeVolume = (v: number): void => {
    setPlayVolume(v);
    playerRef.current?.setVolume(v);
  };

  /** 静音/取消静音某轨；播放中从当前位置重排，立即生效。 */
  const toggleMute = (index: number): void => {
    const next = new Set(muted);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setMuted(next);
    const player = playerRef.current;
    if (!player) return;
    player.setMutedTracks([...next]);
    if (player.isPlaying || player.isPaused) {
      const pos = player.getPosition();
      player.stop();
      void player.play(pos, playVolume).then(() => setPlaying(true));
    }
  };

  const trackLabel = (index: number): string => {
    const name = doc?.tracks[index]?.name?.trim();
    return `${meta?.title ?? 'MIDI'}-${name || `Track${index}`}`;
  };

  const downloadTrack = async (index: number): Promise<void> => {
    const res = (await window.api.midiQuickDownload(midiId, trackLabel(index), index)) as { ok: boolean; path?: string; error?: string };
    if (res.ok) message.success(`已保存到 ${res.path}`);
    else message.error(res.error ?? '下载失败');
  };

  const onTrackDragStart = (e: React.DragEvent, index: number): void => {
    e.preventDefault();
    e.stopPropagation();
    void window.api.midiDrag(midiId, trackLabel(index), index);
  };

  useEffect(() => {
    if (!playing) return;
    const tick = (): void => {
      if (playerRef.current?.isPlaying) {
        setPosition(playerRef.current.getPosition());
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing]);

  const download = async (): Promise<void> => {
    const res = (await window.api.midiQuickDownload(midiId)) as { ok: boolean; path?: string; error?: string };
    if (res.ok) message.success(`已保存到 ${res.path}`);
    else message.error(res.error ?? '下载失败');
  };

  const saveAs = async (): Promise<void> => {
    const res = (await window.api.midiSaveAs(midiId, meta?.title)) as { ok: boolean; path?: string; error?: string };
    if (res.ok) message.success(`已保存到 ${res.path}`);
  };

  const onDragStart = (e: React.DragEvent): void => {
    // 交给 Electron 原生拖拽（拖到桌面/资源管理器即落盘）
    e.preventDefault();
    e.stopPropagation();
    void window.api.midiDrag(midiId, meta?.title);
  };

  if (error) {
    return (
      <div className="midi-card midi-card-error" data-midi-id={midiId}>
        ⚠️ {error}（midiId: {midiId}）
      </div>
    );
  }

  return (
    <div className="midi-card" data-midi-id={midiId} data-testid="midi-card">
      <div className="midi-card-head">
        <div className="midi-card-title">
          <span className="midi-badge">♪</span>
          <span className="midi-title-text">{meta?.title ?? 'MIDI'}</span>
          {meta?.source && <Tag color="purple" style={{ marginInlineEnd: 0 }}>{SOURCE_LABEL[meta.source] ?? meta.source}</Tag>}
        </div>
        <div className="midi-card-meta">
          {meta && (
            <>
              <Tag>{meta.tempoBpm} BPM</Tag>
              <Tag>{meta.barCount} 小节</Tag>
              <Tag>{meta.noteCount} 音符</Tag>
              <Tag>{meta.durationSec}s</Tag>
            </>
          )}
        </div>
      </div>

      {doc ? (
        <div className="midi-roll-wrap" onClick={(e) => e.stopPropagation()}>
          <PianoRoll doc={doc} durationSec={duration || 1} positionSec={playing ? position : position} ccController={ccDisplay} />
        </div>
      ) : (
        <div className="midi-roll-loading">载入 MIDI …</div>
      )}

      {noteTracks.length > 1 && (
        <div className="midi-tracks" data-testid="midi-tracks">
          <span className="midi-tracks-label">分轨</span>
          {noteTracks.map(({ track, index }) => {
            const isMuted = muted.has(index);
            const label = track.name?.trim() || `轨道 ${index}`;
            return (
              <div key={index} className={`midi-track-chip ${isMuted ? 'muted' : ''}`} data-testid={`midi-track-${index}`}>
                <Tooltip title={isMuted ? `取消静音「${label}」` : `静音其他轨可单独试听「${label}」`}>
                  <button
                    className="midi-track-toggle"
                    onClick={() => toggleMute(index)}
                    data-testid={`midi-track-mute-${index}`}
                    aria-pressed={isMuted}
                  >
                    <span className="track-dot" style={{ background: TRACK_COLORS[index % TRACK_COLORS.length] }} />
                    <span className="track-name">{label}</span>
                    <span className="track-count">{track.notes.length}</span>
                  </button>
                </Tooltip>
                <Tooltip title={`下载「${label}」单轨 MIDI`}>
                  <Button size="small" type="text" icon={<DownloadOutlined />} onClick={() => void downloadTrack(index)} data-testid={`midi-track-download-${index}`} />
                </Tooltip>
                <Tooltip title={`按住拖出「${label}」单轨 MIDI`}>
                  <Button
                    size="small"
                    type="text"
                    icon={<DragOutlined />}
                    draggable
                    onDragStart={(e) => onTrackDragStart(e, index)}
                    data-testid={`midi-track-drag-${index}`}
                  />
                </Tooltip>
              </div>
            );
          })}
        </div>
      )}

      <div className="midi-card-actions">
        <Space size={4} wrap>
          <Tooltip title={playing ? '暂停' : '播放'}>
            <Button size="small" type="primary" shape="circle" icon={playing ? <PauseOutlined /> : <CaretRightOutlined />} onClick={() => void togglePlay()} data-testid="midi-play" aria-label={playing ? '暂停' : '播放'} />
          </Tooltip>
          <Tooltip title="回到开头">
            <Button size="small" shape="circle" icon={<ReloadOutlined />} onClick={restart} />
          </Tooltip>
          <div className="midi-progress">
            <Progress percent={duration > 0 ? Math.min(100, (position / duration) * 100) : 0} size={['100%', 4]} showInfo={false} strokeColor="var(--primary)" />
            <span className="midi-time">{fmt(position)} / {fmt(duration)}</span>
          </div>
          <Tooltip title="播放音量">
            <div className="midi-volume" data-testid="midi-volume">
              <SoundOutlined style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
              <Slider
                min={0}
                max={1}
                step={0.05}
                value={playVolume}
                onChange={changeVolume}
                tooltip={{ formatter: (v) => `${Math.round((v ?? 0) * 100)}%` }}
                style={{ width: 78, marginInline: '4px 10px' }}
              />
            </div>
          </Tooltip>
          <Tooltip title="下载到下载目录">
            <Button size="small" icon={<DownloadOutlined />} onClick={() => void download()} data-testid="midi-download">下载</Button>
          </Tooltip>
          <Tooltip title="另存为…">
            <Button size="small" onClick={() => void saveAs()}>另存为</Button>
          </Tooltip>
          <Tooltip title="按住拖到桌面即可导出文件">
            <Button size="small" icon={<DragOutlined />} draggable onDragStart={onDragStart} className="midi-drag-handle" data-testid="midi-drag">
              拖到桌面
            </Button>
          </Tooltip>
          <Tooltip title="打开合成器，捏一个自己的音色">
            <Button size="small" icon={<SlidersOutlined />} onClick={() => setSynthOpen(true)} data-testid="midi-synth">音色</Button>
          </Tooltip>
          <Tooltip title="引用到输入框继续修改">
            <Button
              size="small"
              icon={<MessageOutlined />}
              onClick={() => {
                const st = useAppStore.getState();
                st.appendDraft(st.activeSessionId, `请修改 midiId=${midiId}（${meta?.title ?? 'MIDI'}）：`);
              }}
            >
              继续修改
            </Button>
          </Tooltip>
        </Space>
      </div>
    </div>
  );
}

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function computeDur(doc: MidiDocument): number {
  const tpq = doc.ticksPerQuarter;
  const tempoMap = buildTempoMap(collectTempos(doc), tpq);
  let end = 0;
  for (const t of doc.tracks) {
    for (const n of t.notes) end = Math.max(end, n.endTick);
    for (const c of t.controls) end = Math.max(end, c.tick + 1);
  }
  return end > 0 ? ticksToSec(end, tpq, tempoMap) + 0.5 : 0;
}
