/** 应用根组件：布局 + 全局 Provider + 主题应用。 */
import { useEffect, useLayoutEffect } from 'react';
import { App as AntdApp, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { XProvider } from '@ant-design/x';
import Sidebar from './components/Sidebar';
import ChatPanel from './components/ChatPanel';
import SettingsDrawer from './components/SettingsDrawer';
import SynthPanel from './components/SynthPanel';
import { applyTheme, THEMES } from './theme';
import { initStore, useAppStore } from './store';

initStore();
// 首帧前先应用持久化的主题，避免闪一下默认配色
applyTheme(THEMES[useAppStore.getState().themeId]);

export default function App(): JSX.Element {
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const themeDef = useAppStore((s) => THEMES[s.themeId]);
  const algorithm = themeDef.mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm;

  // 主题切换时同步 CSS 变量（useLayoutEffect 在绘制前生效，避免闪变）
  useLayoutEffect(() => {
    applyTheme(themeDef);
  }, [themeDef]);

  // 阻止默认拖放打开文件行为
  useEffect(() => {
    const prevent = (e: DragEvent): void => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm,
        token: {
          colorPrimary: themeDef.primary,
          borderRadius: 8,
          colorBgLayout: themeDef.bgLayout,
          colorBgContainer: themeDef.bgContainer,
          colorBgElevated: themeDef.bgElevated,
          colorBorder: themeDef.border,
          colorBorderSecondary: themeDef.borderSoft,
        },
      }}
    >
      <XProvider theme={{ algorithm }}>
        <AntdApp className="app-root">
          <div className="app-layout">
            <Sidebar />
            <ChatPanel />
          </div>
          <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
          <SynthPanel />
        </AntdApp>
      </XProvider>
    </ConfigProvider>
  );
}
