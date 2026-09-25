/** 应用根组件：布局 + 全局 Provider。 */
import { useEffect } from 'react';
import { App as AntdApp, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { XProvider } from '@ant-design/x';
import Sidebar from './components/Sidebar';
import ChatPanel from './components/ChatPanel';
import SettingsDrawer from './components/SettingsDrawer';
import SynthPanel from './components/SynthPanel';
import { initStore, useAppStore } from './store';

initStore();

export default function App(): JSX.Element {
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

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
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#7c5cff',
          borderRadius: 8,
          colorBgLayout: '#12121c',
          colorBgContainer: '#1a1a28',
          colorBgElevated: '#202032',
          colorBorder: '#2e2e44',
          colorBorderSecondary: '#26263a',
        },
      }}
    >
      <XProvider theme={{ algorithm: theme.darkAlgorithm }}>
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
