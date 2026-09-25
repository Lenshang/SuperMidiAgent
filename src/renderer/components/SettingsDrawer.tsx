/** 设置抽屉：模型服务 / MCP 服务 / 知识库 / 通用。 */
import { useCallback, useEffect, useState } from 'react';
import {
  App as AntdApp, Button, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Slider,
  Space, Switch, Table, Tag, Typography, Collapse,
} from 'antd';
import {
  ApiOutlined, CheckOutlined, CloudServerOutlined, DatabaseOutlined, DeleteOutlined,
  FolderOpenOutlined, FileAddOutlined, PlusOutlined, ReloadOutlined, StarFilled, SyncOutlined, SettingOutlined,
} from '@ant-design/icons';
import { KbStats, KbSource, McpServerConfig, McpServerState, ModelProfile, SettingsData } from '@shared/types';

interface KbResult {
  title: string;
  score: number;
  text: string;
  sourcePath: string;
}

export default function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [mcpStates, setMcpStates] = useState<McpServerState[]>([]);
  const [kb, setKb] = useState<KbStats | null>(null);
  const [editing, setEditing] = useState<Partial<ModelProfile> | null>(null);
  const [testing, setTesting] = useState<string>(''); // 正在测试的 profile id 或 'new'
  const [addMcpOpen, setAddMcpOpen] = useState(false);
  const [kbQuery, setKbQuery] = useState('');
  const [kbResults, setKbResults] = useState<KbResult[]>([]);
  const { message } = AntdApp.useApp();

  const reload = useCallback(async () => {
    const [s, m, k] = await Promise.all([window.api.settingsGet(), window.api.mcpList(), window.api.kbStats()]);
    setSettings(s);
    setMcpStates(m as McpServerState[]);
    setKb(k as KbStats);
  }, []);

  useEffect(() => {
    if (open) void reload();
    const off = window.api.onMcpStates((states) => setMcpStates(states));
    return off;
  }, [open, reload]);

  const testProfile = async (p: Partial<ModelProfile>, key: string): Promise<void> => {
    setTesting(key);
    try {
      const res = (await window.api.settingsTestProfile({ baseUrl: p.baseUrl ?? '', apiKey: p.apiKey ?? '', model: p.model ?? '' })) as {
        ok: boolean;
        reply?: string;
        error?: string;
      };
      if (res.ok) message.success(`连接成功：${res.reply || 'OK'}`);
      else message.error(`连接失败：${res.error}`);
    } finally {
      setTesting('');
    }
  };

  const refreshStates = useCallback(async () => {
    setMcpStates((await window.api.mcpList()) as McpServerState[]);
  }, []);

  return (
    <Drawer title="设置" placement="right" width={680} open={open} onClose={onClose}>
      {settings && (
        <SettingsTabs
          settings={settings}
          mcpStates={mcpStates}
          reload={reload}
          refreshStates={refreshStates}
          onKb={setKb}
          kb={kb}
          onOpenAddMcp={() => setAddMcpOpen(true)}
          slot={{
            editing,
            setEditing,
            testing,
            testProfile,
            kbQuery,
            setKbQuery,
            kbResults,
            setKbResults,
          }}
        />
      )}
      <Modal title="添加 MCP 服务" open={addMcpOpen} onCancel={() => setAddMcpOpen(false)} footer={null} destroyOnClose>
        <McpAddForm
          onDone={async () => {
            setAddMcpOpen(false);
            await refreshStates();
          }}
        />
      </Modal>
    </Drawer>
  );
}

// ============ 标签页外壳 ============

interface Slot {
  editing: Partial<ModelProfile> | null;
  setEditing: (p: Partial<ModelProfile> | null) => void;
  testing: string;
  testProfile: (p: Partial<ModelProfile>, key: string) => Promise<void>;
  kbQuery: string;
  setKbQuery: (q: string) => void;
  kbResults: KbResult[];
  setKbResults: (r: KbResult[]) => void;
}

function SettingsTabs(props: {
  settings: SettingsData;
  mcpStates: McpServerState[];
  reload: () => Promise<void>;
  refreshStates: () => Promise<void>;
  onKb: (k: KbStats) => void;
  kb: KbStats | null;
  onOpenAddMcp: () => void;
  slot: Slot;
}): JSX.Element {
  const [tab, setTab] = useState<'models' | 'mcp' | 'kb' | 'general'>('models');
  return (
    <div>
      <div className="settings-tabs">
        {(
          [
            ['models', '模型服务', <ApiOutlined key="a" />],
            ['mcp', 'MCP 服务', <CloudServerOutlined key="b" />],
            ['kb', '知识库', <DatabaseOutlined key="c" />],
            ['general', '通用', <SettingOutlined key="d" />],
          ] as const
        ).map(([key, label, icon]) => (
          <button key={key} className={`settings-tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)} data-testid={`tab-${key}`}>
            {icon} {label}
          </button>
        ))}
      </div>
      {tab === 'models' && <ModelsTab settings={props.settings} reload={props.reload} slot={props.slot} />}
      {tab === 'mcp' && <McpTab settings={props.settings} states={props.mcpStates} refresh={props.refreshStates} onAdd={props.onOpenAddMcp} />}
      {tab === 'kb' && <KbTab kb={props.kb} slot={props.slot} onKb={props.onKb} />}
      {tab === 'general' && <GeneralTab settings={props.settings} reload={props.reload} />}
    </div>
  );
}

// ============ 模型服务 ============

function ModelsTab({ settings, reload, slot }: { settings: SettingsData; reload: () => Promise<void>; slot: Slot }): JSX.Element {
  const { message } = AntdApp.useApp();
  const save = async (): Promise<void> => {
    const p = slot.editing;
    if (!p?.name || !p.baseUrl || !p.model || !p.apiKey) {
      message.warning('名称、Base URL、API Key、模型名均为必填');
      return;
    }
    await window.api.settingsUpsertProfile(p);
    await reload();
    slot.setEditing(null);
    message.success('已保存');
  };
  return (
    <div>
      <div className="tab-hint">
        配置任意 OpenAI 兼容接口（MiniMax / DeepSeek / OpenAI / Ollama / one-api…）。
      </div>
      <Select
        style={{ width: '100%', marginBottom: 12 }}
        placeholder="选择默认模型服务"
        value={settings.activeProfileId ?? undefined}
        onChange={async (v) => {
          await window.api.settingsSet({ activeProfileId: v });
          await reload();
        }}
        options={settings.profiles.map((p) => ({ value: p.id, label: `${p.name}（${p.model}）` }))}
        data-testid="default-profile-select"
      />
      {settings.profiles.map((p) => (
        <div key={p.id} className="profile-card" data-profile-name={p.name}>
          <div className="profile-head">
            <Space>
              {settings.activeProfileId === p.id && <Tag color="gold" icon={<StarFilled />}>默认</Tag>}
              <b>{p.name}</b>
              <Tag color="blue">{p.model}</Tag>
            </Space>
            <Space>
              <Button size="small" icon={<ApiOutlined />} loading={slot.testing === p.id} onClick={() => void slot.testProfile(p, p.id)} data-testid={`test-profile-${p.name}`}>测试</Button>
              <Button size="small" onClick={() => slot.setEditing(p)}>编辑</Button>
              {settings.activeProfileId !== p.id && (
                <Button size="small" icon={<CheckOutlined />} onClick={async () => { await window.api.settingsSet({ activeProfileId: p.id }); await reload(); }}>设为默认</Button>
              )}
              <Popconfirm title="确定删除该配置？" onConfirm={async () => { await window.api.settingsRemoveProfile(p.id); await reload(); }}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </Space>
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{p.baseUrl}</Typography.Text>
        </div>
      ))}
      <Button type="dashed" block icon={<PlusOutlined />} data-testid="add-profile" onClick={() => slot.setEditing({ name: '', baseUrl: '', apiKey: '', model: '', temperature: 0.7 })}>
        添加模型服务
      </Button>

      <Modal
        title={slot.editing?.id ? '编辑模型服务' : '添加模型服务'}
        open={!!slot.editing}
        onCancel={() => slot.setEditing(null)}
        onOk={() => void save()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        {slot.editing && (
          <Form layout="vertical" style={{ marginTop: 12 }}>
            <Form.Item label="名称" required>
              <Input value={slot.editing.name} onChange={(e) => slot.setEditing({ ...slot.editing, name: e.target.value })} placeholder="如 MiniMax-M3" />
            </Form.Item>
            <Form.Item label="Base URL" required>
              <Input value={slot.editing.baseUrl} onChange={(e) => slot.setEditing({ ...slot.editing, baseUrl: e.target.value })} placeholder="https://api.minimax.cn/v1" />
            </Form.Item>
            <Form.Item label="API Key" required>
              <Input.Password value={slot.editing.apiKey} onChange={(e) => slot.setEditing({ ...slot.editing, apiKey: e.target.value })} placeholder="sk-..." />
            </Form.Item>
            <Form.Item label="模型名称" required>
              <Input value={slot.editing.model} onChange={(e) => slot.setEditing({ ...slot.editing, model: e.target.value })} placeholder="MiniMax-M3" />
            </Form.Item>
            <Form.Item label={`温度 ${slot.editing.temperature ?? 0.7}`}>
              <Slider min={0} max={2} step={0.1} value={slot.editing.temperature ?? 0.7} onChange={(v) => slot.setEditing({ ...slot.editing, temperature: v })} />
            </Form.Item>
            <Form.Item label="最大生成 Token（可选）">
              <InputNumber min={256} max={65536} style={{ width: '100%' }} value={slot.editing.maxTokens} onChange={(v) => slot.setEditing({ ...slot.editing, maxTokens: v ?? undefined })} placeholder="留空使用服务默认" />
            </Form.Item>
            <Button loading={slot.testing === 'new'} onClick={() => void slot.testProfile(slot.editing!, 'new')}>测试连接</Button>
          </Form>
        )}
      </Modal>
    </div>
  );
}

// ============ MCP 服务 ============

function McpTab({ states, refresh, onAdd }: { settings: SettingsData; states: McpServerState[]; refresh: () => Promise<void>; onAdd: () => void }): JSX.Element {
  const { message } = AntdApp.useApp();
  return (
    <div>
      <div className="tab-hint">MCP（Model Context Protocol）服务为 AI 提供工具。内置 MIDI 工具随应用提供，也可接入外部 MCP 服务器（stdio / HTTP）。</div>
      <Button type="dashed" block icon={<PlusOutlined />} onClick={onAdd} style={{ marginBottom: 12 }} data-testid="add-mcp">
        添加 MCP 服务
      </Button>
      {states.map((s) => (
        <div key={s.id} className="mcp-card" data-mcp-name={s.name} data-mcp-status={s.status}>
          <div className="profile-head">
            <Space>
              {s.builtin && <Tag color="purple">内置</Tag>}
              <b>{s.name}</b>
              <Tag>{s.type === 'stdio' ? 'stdio' : 'http'}</Tag>
              {s.status === 'connected' && <Tag color="success" icon={<CheckOutlined />}>已连接</Tag>}
              {s.status === 'connecting' && <Tag color="processing" icon={<SyncOutlined spin />}>连接中</Tag>}
              {s.status === 'disabled' && <Tag>已停用</Tag>}
              {s.status === 'error' && <Tag color="error">错误</Tag>}
            </Space>
            <Space>
              <Switch checked={s.enabled} onChange={async (v) => { await window.api.mcpSetEnabled(s.id, v); await refresh(); }} data-testid={`mcp-switch-${s.name}`} />
              {!s.builtin && (
                <>
                  <Button size="small" icon={<ReloadOutlined />} onClick={async () => { await window.api.mcpRestart(s.id); await refresh(); }} />
                  <Popconfirm
                    title="确定移除该 MCP 服务？"
                    onConfirm={async () => {
                      await window.api.mcpRemove(s.id);
                      await refresh();
                      message.success('已移除');
                    }}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </>
              )}
            </Space>
          </div>
          {s.error && <div className="mcp-error">{s.error}</div>}
          {s.tools.length > 0 && (
            <Collapse
              size="small"
              items={[
                {
                  key: 'tools',
                  label: `${s.tools.length} 个工具`,
                  children: (
                    <div>
                      {s.tools.map((t) => (
                        <div key={t.name} className="mcp-tool">
                          <code>{t.exposedName}</code>
                          <span>{t.description?.slice(0, 90)}</span>
                        </div>
                      ))}
                    </div>
                  ),
                },
              ]}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ============ 知识库 ============

function KbTab({ kb, slot, onKb }: { kb: KbStats | null; slot: Slot; onKb: (k: KbStats) => void }): JSX.Element {
  const { message } = AntdApp.useApp();
  if (!kb) return <div>加载中…</div>;
  const importKb = async (picker: 'files' | 'folder'): Promise<void> => {
    const paths = picker === 'files' ? await window.api.pickKbFiles() : await window.api.pickKbFolder();
    if (!paths || paths.length === 0) return;
    onKb((await window.api.kbAddPaths(paths)) as KbStats);
    message.success('知识库已更新');
  };
  return (
    <div>
      <div className="tab-hint">知识库让 AI 检索你的本地文档（txt / md / pdf / 代码等）。聊天区开启"知识库"后自动检索注入。</div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button icon={<FileAddOutlined />} onClick={() => void importKb('files')} data-testid="kb-add-files">添加文件</Button>
        <Button icon={<FolderOpenOutlined />} onClick={() => void importKb('folder')} data-testid="kb-add-folder">添加文件夹</Button>
        <Button icon={<ReloadOutlined />} onClick={async () => onKb((await window.api.kbRebuild()) as KbStats)}>重建索引</Button>
        <Tag>{kb.sources.length} 来源</Tag>
        <Tag>{kb.totalChunks} 内容块</Tag>
      </Space>
      <Table
        size="small"
        rowKey="id"
        dataSource={kb.sources}
        pagination={false}
        columns={[
          { title: '路径', dataIndex: 'path', ellipsis: true },
          { title: '类型', dataIndex: 'kind', width: 70 },
          { title: '文件', dataIndex: 'fileCount', width: 60 },
          { title: '块', dataIndex: 'chunkCount', width: 60 },
          {
            title: '启用',
            width: 70,
            render: (_: unknown, r: KbSource) => (
              <Switch size="small" checked={r.enabled} onChange={async (v) => onKb((await window.api.kbSetSourceEnabled(r.id, v)) as KbStats)} />
            ),
          },
          {
            title: '',
            width: 50,
            render: (_: unknown, r: KbSource) => (
              <Button size="small" danger icon={<DeleteOutlined />} onClick={async () => onKb((await window.api.kbRemoveSource(r.id)) as KbStats)} />
            ),
          },
        ]}
      />
      <div style={{ marginTop: 16 }}>
        <Space.Compact style={{ width: '100%' }}>
          <Input value={slot.kbQuery} onChange={(e) => slot.setKbQuery(e.target.value)} placeholder="测试检索…" data-testid="kb-search-input" />
          <Button
            type="primary"
            data-testid="kb-search-btn"
            onClick={async () => {
              const res = (await window.api.kbSearch(slot.kbQuery, 4)) as KbResult[];
              slot.setKbResults(res);
            }}
          >
            搜索
          </Button>
        </Space.Compact>
        {slot.kbResults.map((r, i) => (
          <div key={i} className="kb-result">
            <b>{r.title}</b> <Tag>{r.score}</Tag>
            <div className="kb-result-text">{r.text.slice(0, 200)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============ 通用 ============

function GeneralTab({ settings, reload }: { settings: SettingsData; reload: () => Promise<void> }): JSX.Element {
  return (
    <div>
      <div className="profile-card">
        <div className="profile-head"><b>Agent 最大工具轮次</b></div>
        <InputNumber
          min={1}
          max={40}
          value={settings.agentMaxIterations}
          style={{ width: 120 }}
          onChange={async (v) => {
            await window.api.settingsSet({ agentMaxIterations: v ?? 12 });
            await reload();
          }}
        />
        <div className="tab-hint">单条消息中 AI 最多连续调用工具的轮次。</div>
      </div>
      <div className="profile-card">
        <div className="profile-head"><b>播放音量</b></div>
        <Slider
          min={0}
          max={1}
          step={0.05}
          defaultValue={settings.volume}
          style={{ width: 240 }}
          onChange={async (v) => {
            await window.api.settingsSet({ volume: v });
          }}
        />
      </div>
    </div>
  );
}

// ============ MCP 添加表单 ============

function McpAddForm({ onDone }: { onDone: () => Promise<void> }): JSX.Element {
  const [form] = Form.useForm();
  const type = Form.useWatch('type', form) ?? 'stdio';
  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={{ type: 'stdio' }}
      onFinish={async (values) => {
        let headers: Record<string, string> | undefined;
        if (values.headers) {
          try {
            headers = JSON.parse(values.headers);
          } catch {
            headers = undefined;
          }
        }
        const cfg: McpServerConfig = {
          id: '',
          name: values.name,
          type: values.type,
          enabled: true,
          command: values.command,
          args: values.args ? String(values.args).trim().split(/\s+/) : [],
          url: values.url,
          headers,
        };
        await window.api.mcpAdd(cfg);
        await onDone();
      }}
    >
      <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
        <Input placeholder="如 filesystem" />
      </Form.Item>
      <Form.Item name="type" label="类型" rules={[{ required: true }]}>
        <Select options={[{ value: 'stdio', label: 'stdio（本地命令）' }, { value: 'http', label: 'HTTP（远程 URL）' }]} />
      </Form.Item>
      {type === 'stdio' ? (
        <>
          <Form.Item name="command" label="命令" rules={[{ required: true, message: '请输入命令' }]}>
            <Input placeholder="如 npx 或 node" />
          </Form.Item>
          <Form.Item name="args" label="参数（空格分隔）">
            <Input placeholder="-y @modelcontextprotocol/server-filesystem D:\docs" />
          </Form.Item>
        </>
      ) : (
        <>
          <Form.Item name="url" label="URL" rules={[{ required: true, message: '请输入 URL' }]}>
            <Input placeholder="https://example.com/mcp" />
          </Form.Item>
          <Form.Item name="headers" label="请求头（JSON，可选）">
            <Input.TextArea rows={2} placeholder='{"Authorization":"Bearer xxx"}' />
          </Form.Item>
        </>
      )}
      <Button type="primary" htmlType="submit" block data-testid="mcp-save">
        保存并连接
      </Button>
    </Form>
  );
}
