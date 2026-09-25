/** 左侧边栏：会话列表（AntDX Conversations）+ 新建 + 设置入口。 */
import { Button, Typography } from 'antd';
import { Conversations } from '@ant-design/x';
import { PlusOutlined, SettingOutlined, DeleteOutlined } from '@ant-design/icons';
import { useAppStore } from '../store';

export default function Sidebar(): JSX.Element {
  const sessions = useAppStore((s) => s.sessions);
  const activeId = useAppStore((s) => s.activeSessionId);

  const items = sessions.map((s) => ({
    key: s.id,
    label: s.title,
    icon: null,
  }));

  return (
    <div className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-icon">♪</span>
        <div>
          <div className="brand-name">SuperMidiAgent</div>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>AI MIDI 创作工作台</Typography.Text>
        </div>
      </div>

      <Button
        type="primary"
        block
        icon={<PlusOutlined />}
        onClick={() => useAppStore.getState().newSession()}
        className="new-chat-btn"
        data-testid="new-chat"
      >
        新建对话
      </Button>

      <div className="conversation-list">
        <Conversations
          activeKey={activeId}
          onActiveChange={(id: string) => useAppStore.getState().setActiveSession(id)}
          items={items.map((it: { key: string; label: string; icon: null }) => ({
            ...it,
            menu: {
              icon: <DeleteOutlined />,
              items: [{ key: 'delete', label: '删除', danger: true, icon: <DeleteOutlined /> }],
              onClick: ({ key }: { key: string }) => {
                if (key === 'delete') useAppStore.getState().removeSession(it.key);
              },
            },
          }))}
          menu={{ items: [] }}
        />
        {items.length === 0 && <div className="conv-empty">暂无会话</div>}
      </div>

      <div className="sidebar-footer">
        <Button
          icon={<SettingOutlined />}
          onClick={() => useAppStore.getState().setSettingsOpen(true)}
          data-testid="open-settings"
        >
          设置
        </Button>
      </div>
    </div>
  );
}
