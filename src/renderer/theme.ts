/** 内置主题：每套主题提供 antd token 与 CSS 变量，设置里切换。 */

export type ThemeId =
  | 'nebula' // 星云紫（默认，原暗紫配色）
  | 'ocean' // 深海蓝
  | 'forest' // 幽林绿
  | 'ember' // 落日橙
  | 'obsidian' // 曜石黑
  | 'daylight' // 晨光（亮）
  | 'sakura' // 樱粉（亮）
  | 'mint'; // 薄荷（亮）

interface ThemeSpec {
  id: ThemeId;
  label: string;
  mode: 'dark' | 'light';
  primary: string;
  brandSecond: string;
  bgLayout: string;
  bgContainer: string;
  bgElevated: string;
  border: string;
  borderSoft: string;
  borderStrong: string;
  textStrong: string;
  textSecondary: string;
  textFaint: string;
  accentLive: string;
  accentSoft: string;
  info: string;
  danger: string;
  warning: string;
  preBg: string;
  inlineBg: string;
  inlineColor: string;
  maskBg: string;
  panelOverlay: string;
  appGradient: string;
  cardGradient: string;
  scrollbar: string;
  scrollbarHover: string;
}

export interface ThemeDef extends ThemeSpec {
  vars: Record<string, string>;
  chip: string;
}

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function defineTheme(s: ThemeSpec): ThemeDef {
  const vars: Record<string, string> = {
    '--primary': s.primary,
    '--primary-faint': rgba(s.primary, 0.09),
    '--primary-faintest': rgba(s.primary, 0.055),
    '--primary-quarter': rgba(s.primary, 0.33),
    '--primary-half': rgba(s.primary, 0.4),
    '--brand-gradient': `linear-gradient(135deg, ${s.primary}, ${s.brandSecond})`,
    '--app-gradient': s.appGradient,
    '--panel-overlay': s.panelOverlay,
    '--card-gradient': s.cardGradient,
    '--mask-bg': s.maskBg,
    '--border': s.border,
    '--border-soft': s.borderSoft,
    '--border-strong': s.borderStrong,
    '--text-strong': s.textStrong,
    '--text-secondary': s.textSecondary,
    '--text-faint': s.textFaint,
    '--accent-live': s.accentLive,
    '--accent-soft': s.accentSoft,
    '--info': s.info,
    '--danger': s.danger,
    '--warning': s.warning,
    '--code-bg': s.preBg,
    '--inline-code-bg': s.inlineBg,
    '--inline-code-color': s.inlineColor,
    '--scrollbar-thumb': s.scrollbar,
    '--scrollbar-thumb-hover': s.scrollbarHover,
  };
  const chip = `linear-gradient(135deg, ${s.primary} 0%, ${s.primary} 46%, ${s.bgContainer} 46%, ${s.bgContainer} 100%)`;
  return { ...s, vars, chip };
}

// 暗色主题共用的中性灰阶
const darkCommon = {
  textStrong: '#cfcfe4',
  textSecondary: '#9a9ab4',
  textFaint: '#7d7d99',
  info: '#8ab4ff',
  danger: '#ff6b6b',
  warning: '#ff9c6b',
  inlineColor: '#ffcf87',
  panelOverlay: 'rgba(0, 0, 0, 0.16)',
  scrollbar: '#33334e',
  scrollbarHover: '#45456a',
} as const;

// 亮色主题共用的中性灰阶
const lightCommon = {
  textStrong: '#1f2329',
  textSecondary: '#595f6d',
  textFaint: '#8a909c',
  info: '#2f6bd8',
  danger: '#e5484d',
  warning: '#c25e0a',
  inlineColor: '#9a5b00',
  panelOverlay: 'rgba(15, 23, 42, 0.035)',
  scrollbar: '#d4d7e0',
  scrollbarHover: '#bfc4d2',
} as const;

export const THEMES: Record<ThemeId, ThemeDef> = {
  nebula: defineTheme({
    ...darkCommon,
    id: 'nebula',
    label: '星云紫',
    mode: 'dark',
    primary: '#7c5cff',
    brandSecond: '#00c2a8',
    bgLayout: '#12121c',
    bgContainer: '#1a1a28',
    bgElevated: '#202032',
    border: '#2e2e44',
    borderSoft: '#26263a',
    borderStrong: '#343452',
    accentLive: '#b9a8ff',
    accentSoft: '#9a8ad0',
    preBg: '#12121e',
    inlineBg: '#26263a',
    maskBg: 'rgba(18, 18, 28, 0.82)',
    appGradient: 'linear-gradient(160deg, #12121c 0%, #161624 60%, #1a1630 100%)',
    cardGradient: 'linear-gradient(150deg, #201f33, #1c1b2e)',
  }),
  ocean: defineTheme({
    ...darkCommon,
    id: 'ocean',
    label: '深海蓝',
    mode: 'dark',
    primary: '#4aa8ff',
    brandSecond: '#3ddad0',
    bgLayout: '#0e1622',
    bgContainer: '#152234',
    bgElevated: '#1b2c44',
    border: '#22374e',
    borderSoft: '#1c2e42',
    borderStrong: '#2b4360',
    accentLive: '#8cc8ff',
    accentSoft: '#7fa8d8',
    preBg: '#0f1a28',
    inlineBg: '#22374e',
    maskBg: 'rgba(14, 22, 34, 0.82)',
    appGradient: 'linear-gradient(160deg, #0e1622 0%, #101c2c 60%, #12233c 100%)',
    cardGradient: 'linear-gradient(150deg, #18293e, #152539)',
  }),
  forest: defineTheme({
    ...darkCommon,
    id: 'forest',
    label: '幽林绿',
    mode: 'dark',
    primary: '#35c98e',
    brandSecond: '#a8d84c',
    bgLayout: '#0f1714',
    bgContainer: '#152220',
    bgElevated: '#1b2b27',
    border: '#243a32',
    borderSoft: '#1e2f29',
    borderStrong: '#2d473c',
    accentLive: '#7fe0b6',
    accentSoft: '#6fbf9d',
    preBg: '#0f1a15',
    inlineBg: '#243a32',
    maskBg: 'rgba(15, 23, 20, 0.82)',
    appGradient: 'linear-gradient(160deg, #0f1714 0%, #11201a 60%, #13251d 100%)',
    cardGradient: 'linear-gradient(150deg, #1a2b25, #172620)',
  }),
  ember: defineTheme({
    ...darkCommon,
    id: 'ember',
    label: '落日橙',
    mode: 'dark',
    primary: '#ff7a59',
    brandSecond: '#ffb257',
    bgLayout: '#191210',
    bgContainer: '#241a15',
    bgElevated: '#2d211a',
    border: '#3e2c22',
    borderSoft: '#33241c',
    borderStrong: '#4a352a',
    accentLive: '#ffb59d',
    accentSoft: '#d89a80',
    preBg: '#1a1210',
    inlineBg: '#3e2c22',
    maskBg: 'rgba(25, 18, 16, 0.82)',
    appGradient: 'linear-gradient(160deg, #191210 0%, #1d1512 60%, #261811 100%)',
    cardGradient: 'linear-gradient(150deg, #2a1d16, #251a14)',
  }),
  obsidian: defineTheme({
    ...darkCommon,
    id: 'obsidian',
    label: '曜石黑',
    mode: 'dark',
    primary: '#9d92ff',
    brandSecond: '#00c2a8',
    bgLayout: '#050508',
    bgContainer: '#0e0e14',
    bgElevated: '#16161e',
    border: '#24242e',
    borderSoft: '#1a1a22',
    borderStrong: '#303040',
    accentLive: '#b3b3ff',
    accentSoft: '#8a8ac0',
    preBg: '#0a0a10',
    inlineBg: '#20202a',
    maskBg: 'rgba(5, 5, 8, 0.85)',
    panelOverlay: 'rgba(0, 0, 0, 0.4)',
    scrollbar: '#2a2a36',
    scrollbarHover: '#3c3c4c',
    appGradient: 'linear-gradient(160deg, #050508 0%, #08080e 60%, #0b0b12 100%)',
    cardGradient: 'linear-gradient(150deg, #13131c, #101018)',
  }),
  daylight: defineTheme({
    ...lightCommon,
    id: 'daylight',
    label: '晨光',
    mode: 'light',
    primary: '#6c4fd8',
    brandSecond: '#00a896',
    bgLayout: '#f4f5fa',
    bgContainer: '#ffffff',
    bgElevated: '#ffffff',
    border: '#e0e3ee',
    borderSoft: '#e9ebf4',
    borderStrong: '#d5d9e8',
    accentLive: '#6c4fd8',
    accentSoft: '#7a68c8',
    preBg: '#f2f3f8',
    inlineBg: '#eceef6',
    maskBg: 'rgba(248, 249, 252, 0.85)',
    appGradient: 'linear-gradient(160deg, #f4f5fa 0%, #f0f2f9 60%, #f1f0fa 100%)',
    cardGradient: 'linear-gradient(150deg, #ffffff, #f7f8fc)',
  }),
  sakura: defineTheme({
    ...lightCommon,
    id: 'sakura',
    label: '樱粉',
    mode: 'light',
    primary: '#d6498c',
    brandSecond: '#f783ac',
    bgLayout: '#faf3f6',
    bgContainer: '#ffffff',
    bgElevated: '#fff5f9',
    border: '#f0dbe5',
    borderSoft: '#f5e6ed',
    borderStrong: '#e8ccd9',
    accentLive: '#d6498c',
    accentSoft: '#c04a86',
    preBg: '#f8eef3',
    inlineBg: '#f5e3ec',
    maskBg: 'rgba(250, 243, 246, 0.85)',
    appGradient: 'linear-gradient(160deg, #faf3f6 0%, #f8eff4 60%, #faf0f6 100%)',
    cardGradient: 'linear-gradient(150deg, #ffffff, #fdf3f7)',
  }),
  mint: defineTheme({
    ...lightCommon,
    id: 'mint',
    label: '薄荷',
    mode: 'light',
    primary: '#0e9c7c',
    brandSecond: '#4cc2a0',
    bgLayout: '#f2f8f5',
    bgContainer: '#ffffff',
    bgElevated: '#f6fbf8',
    border: '#dbeae2',
    borderSoft: '#e5f0ea',
    borderStrong: '#cde2d6',
    accentLive: '#0e9c7c',
    accentSoft: '#0c8a6e',
    preBg: '#eef6f1',
    inlineBg: '#e3f0e8',
    maskBg: 'rgba(242, 248, 245, 0.85)',
    appGradient: 'linear-gradient(160deg, #f2f8f5 0%, #eff7f3 60%, #f0f9f4 100%)',
    cardGradient: 'linear-gradient(150deg, #ffffff, #f4faf7)',
  }),
};

export const DEFAULT_THEME_ID: ThemeId = 'nebula';

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && v in THEMES;
}

/** 把主题的 CSS 变量写到根节点（antd token 由 App.tsx 的 ConfigProvider 处理）。 */
export function applyTheme(t: ThemeDef): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
  root.dataset.theme = t.id;
}
