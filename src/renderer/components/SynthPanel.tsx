/** 音色编辑器（"捏音色"）：双振荡器 / ADSR / 滤波器 / EQ / 颤音，含预设与试听。 */
import { useEffect } from 'react';
import { Button, Drawer, Select, Slider, Switch, Tooltip, Space, Typography } from 'antd';
import { PlayCircleOutlined, StopOutlined, UndoOutlined } from '@ant-design/icons';
import { useAppStore } from '../store';
import { SYNTH_PRESETS, DEFAULT_SYNTH, WaveType, SynthSettings, playPreview, stopPreview, closePreview } from '../audio/synthEngine';

const WAVES: { value: WaveType; label: string }[] = [
  { value: 'sine', label: '正弦波 ∿' },
  { value: 'square', label: '方波 ⊓' },
  { value: 'sawtooth', label: '锯齿波 ⩘' },
  { value: 'triangle', label: '三角波 ◇' },
];

const OCTAVES = [-2, -1, 0, 1, 2].map((o) => ({ value: o, label: o > 0 ? `+${o} 八度` : o === 0 ? '原音高' : `${o} 八度` }));

/** 音量类滑块（0-1 → 0-100 显示）。 */
function LevelSlider({ value, onChange, ...rest }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; tooltip?: string }): JSX.Element {
  return (
    <Slider
      value={Math.round(value * 100)}
      onChange={(v) => onChange(v / 100)}
      tooltip={{ formatter: (v) => `${v}%` }}
      {...(rest as object)}
    />
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="synth-section">
      <div className="synth-section-title">{title}</div>
      {children}
    </div>
  );
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }): JSX.Element {
  return (
    <div className="synth-row">
      <span className="synth-row-label" title={hint}>{label}</span>
      <div className="synth-row-control">{children}</div>
    </div>
  );
}

/** 对数频率滑块：80Hz - 16kHz。 */
function CutoffSlider({ value, onChange }: { value: number; onChange: (hz: number) => void }): JSX.Element {
  const toSlider = (hz: number): number => Math.round((Math.log2(hz / 80) / Math.log2(16384 / 80)) * 100);
  const fromSlider = (v: number): number => Math.round(80 * Math.pow(2, (v / 100) * Math.log2(16384 / 80)));
  return (
    <Slider
      min={0}
      max={100}
      value={toSlider(Math.min(16384, Math.max(80, value)))}
      onChange={(v) => onChange(fromSlider(v))}
      tooltip={{ formatter: (v) => `${fromSlider(v ?? 0)} Hz` }}
    />
  );
}

export default function SynthPanel(): JSX.Element {
  const open = useAppStore((s) => s.synthOpen);
  const synth = useAppStore((s) => s.synth);
  const enabled = useAppStore((s) => s.synthEnabled);
  const setSynth = useAppStore((s) => s.setSynth);
  const setSynthEnabled = useAppStore((s) => s.setSynthEnabled);
  const setSynthOpen = useAppStore((s) => s.setSynthOpen);

  useEffect(() => {
    if (!open) stopPreview();
    return () => {
      if (!open) stopPreview();
    };
  }, [open]);

  const patch = (p: Partial<SynthSettings>): void => setSynth({ ...synth, ...p });

  return (
    <Drawer
      title="合成器 · 捏音色"
      placement="right"
      width={480}
      open={open}
      onClose={() => setSynthOpen(false)}
      className="synth-drawer"
      destroyOnClose={false}
      data-testid="synth-drawer"
    >
      <div className="synth-mode-row">
        <div>
          <div className="synth-mode-title">启用自定义音色</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {enabled ? '所有非鼓组轨道使用下方音色' : '当前使用内置 GM 音色映射'}
          </Typography.Text>
        </div>
        <Switch checked={enabled} onChange={setSynthEnabled} data-testid="synth-enabled" />
      </div>

      <Space style={{ width: '100%', marginBottom: 8 }} wrap>
        <Select
          style={{ width: 170 }}
          placeholder="加载预设…"
          value={null}
          onChange={(name) => {
            const preset = SYNTH_PRESETS.find((p) => p.name === name);
            if (preset) setSynth(JSON.parse(JSON.stringify(preset.settings)));
          }}
          options={SYNTH_PRESETS.map((p) => ({ value: p.name, label: p.name }))}
          data-testid="synth-preset"
        />
        <Tooltip title="播放一段琶音试听当前音色">
          <Button icon={<PlayCircleOutlined />} onClick={() => playPreview(synth)} data-testid="synth-preview">试听</Button>
        </Tooltip>
        <Tooltip title="停止试听">
          <Button icon={<StopOutlined />} onClick={stopPreview} />
        </Tooltip>
        <Tooltip title="恢复默认音色">
          <Button icon={<UndoOutlined />} onClick={() => setSynth(JSON.parse(JSON.stringify(DEFAULT_SYNTH)))} />
        </Tooltip>
      </Space>

      <Section title="振荡器 Oscillators">
        <Row label="波形 1">
          <Select size="small" style={{ width: 130 }} value={synth.osc1.wave} options={WAVES} onChange={(w) => patch({ osc1: { ...synth.osc1, wave: w } })} />
        </Row>
        <Row label="音高 1">
          <Select size="small" style={{ width: 110 }} value={synth.osc1.octave} options={OCTAVES} onChange={(o) => patch({ osc1: { ...synth.osc1, octave: o } })} />
        </Row>
        <Row label="电平 1">
          <LevelSlider min={0} max={100} value={synth.osc1.level} onChange={(v) => patch({ osc1: { ...synth.osc1, level: v }})} />
        </Row>
        <Row label="波形 2">
          <Select size="small" style={{ width: 130 }} value={synth.osc2.wave} options={WAVES} onChange={(w) => patch({ osc2: { ...synth.osc2, wave: w } })} />
        </Row>
        <Row label="音高 2">
          <Select size="small" style={{ width: 110 }} value={synth.osc2.octave} options={OCTAVES} onChange={(o) => patch({ osc2: { ...synth.osc2, octave: o } })} />
        </Row>
        <Row label="电平 2">
          <LevelSlider min={0} max={100} value={synth.osc2.level} onChange={(v) => patch({ osc2: { ...synth.osc2, level: v } })} />
        </Row>
        <Row label="失谐 2" hint="第二个振荡器与第一个的音分偏差，制造合唱/宽度感">
          <Slider min={-50} max={50} value={synth.osc2.detune} onChange={(v) => patch({ osc2: { ...synth.osc2, detune: v } })} tooltip={{ formatter: (v) => `${v} cents` }} />
        </Row>
      </Section>

      <Section title="包络 ADSR">
        <Row label="起音 A" hint="从静音到峰值的时长">
          <Slider min={1} max={800} value={Math.round(synth.adsr.attack * 1000)} onChange={(v) => patch({ adsr: { ...synth.adsr, attack: v / 1000 } })} tooltip={{ formatter: (v) => `${(v ?? 0) / 1000}s` }} />
        </Row>
        <Row label="衰减 D" hint="从峰值回落到延音电平的时长">
          <Slider min={10} max={2000} value={Math.round(synth.adsr.decay * 1000)} onChange={(v) => patch({ adsr: { ...synth.adsr, decay: v / 1000 } })} tooltip={{ formatter: (v) => `${(v ?? 0) / 1000}s` }} />
        </Row>
        <Row label="延音 S" hint="长音持续的电平（相对峰值）">
          <Slider min={0} max={100} value={Math.round(synth.adsr.sustain * 100)} onChange={(v) => patch({ adsr: { ...synth.adsr, sustain: v / 100 } })} tooltip={{ formatter: (v) => `${v}%` }} />
        </Row>
        <Row label="释音 R" hint="音符结束后淡出的时长">
          <Slider min={20} max={3000} value={Math.round(synth.adsr.release * 1000)} onChange={(v) => patch({ adsr: { ...synth.adsr, release: v / 1000 } })} tooltip={{ formatter: (v) => `${(v ?? 0) / 1000}s` }} />
        </Row>
      </Section>

      <Section title="滤波器 Filter">
        <Row label="亮度" hint="低通截止频率">
          <CutoffSlider value={synth.filter.cutoff} onChange={(hz) => patch({ filter: { ...synth.filter, cutoff: hz } })} />
        </Row>
        <Row label="共鸣" hint="共振强度（Q），高值更有电子感">
          <Slider min={0} max={12} step={0.1} value={synth.filter.q} onChange={(v) => patch({ filter: { ...synth.filter, q: v } })} />
        </Row>
        <Row label="亮度包络" hint="起音时滤波器从暗到亮的扫频幅度（八度）">
          <Slider min={0} max={4} step={0.1} value={synth.filter.env} onChange={(v) => patch({ filter: { ...synth.filter, env: v } })} />
        </Row>
      </Section>

      <Section title="均衡 EQ">
        <Row label="低频" hint="260Hz 低架">
          <Slider min={-12} max={12} step={0.5} value={synth.eq.low} onChange={(v) => patch({ eq: { ...synth.eq, low: v } })} tooltip={{ formatter: (v) => `${v} dB` }} />
        </Row>
        <Row label="中频" hint="1.4kHz 峰值">
          <Slider min={-12} max={12} step={0.5} value={synth.eq.mid} onChange={(v) => patch({ eq: { ...synth.eq, mid: v } })} tooltip={{ formatter: (v) => `${v} dB` }} />
        </Row>
        <Row label="高频" hint="5.2kHz 高架">
          <Slider min={-12} max={12} step={0.5} value={synth.eq.high} onChange={(v) => patch({ eq: { ...synth.eq, high: v } })} tooltip={{ formatter: (v) => `${v} dB` }} />
        </Row>
      </Section>

      <Section title="颤音 Vibrato">
        <Row label="速率">
          <Slider min={0} max={9} step={0.1} value={synth.vibrato.rate} onChange={(v) => patch({ vibrato: { ...synth.vibrato, rate: v } })} tooltip={{ formatter: (v) => `${v} Hz` }} />
        </Row>
        <Row label="深度" hint="0 关闭颤音">
          <Slider min={0} max={50} value={synth.vibrato.depth} onChange={(v) => patch({ vibrato: { ...synth.vibrato, depth: v } })} tooltip={{ formatter: (v) => `${v} cents` }} />
        </Row>
      </Section>

      <Section title="总音量">
        <LevelSlider value={synth.volume} onChange={(v) => patch({ volume: v })} />
      </Section>

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        提示：设置会自动保存，对下一次播放生效；用「试听」可即时预览。播放中的音量可用卡片上的滑块实时调节。
      </Typography.Text>
    </Drawer>
  );
}
