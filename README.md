# SuperMidiAgent

基于 **Electron + React + Ant Design X + MCP** 的 AI MIDI 生成与编辑工作台。

![技术栈](https://img.shields.io/badge/Electron-44-47848f) ![React 18](https://img.shields.io/badge/React-18-61dafb) ![Ant Design X 2](https://img.shields.io/badge/AntDesignX-2-1677ff) ![MCP](https://img.shields.io/badge/MCP-SDK-000)

## 功能特性

### 🎼 AI 生成 MIDI
- 对话式创作：描述需求（调性、速度、小节、情绪），AI 通过内置 MCP 工具 `create_midi` 逐音符创作
- 聊天窗口内 MIDI 卡片：**直接播放**（内置 WebAudio 合成器）、**下载**（保存到下载目录 / 另存为）、**拖拽到桌面**导出
- 钢琴卷帘可视化 + 播放指针

### 🔧 AI 分析与修改 MIDI
- 把 `.mid` / `.midi` 文件**拖进窗口**（或点击"导入 MIDI"），AI 自动分析：调性（Krumhansl-Schmuckler）、逐小节和弦、力度分布、CC 控制器状态
- 修改操作（生成新版本，原版保留）：
  - `humanize_velocity` — 真实力度：乐句弧线 + 节拍重音 + 长音强调 + 旋律突出 + 微抖动（种子可复现）
  - `add_cc11` — 真实表情曲线：逐乐句弧线、长音 swell、乐句间呼吸、滑动平均平滑
  - `change_chords` — 改变和弦进行：和弦符号解析（Cmaj7 / F#m7b5 / Gsus4 / C/E…）、声部连接、柱式/琶音/分解织体
  - `add_sustain` 延音踏板、`humanize_timing` 时值微偏移、`transpose`、`quantize`、`set_tempo`、`set_program` 等

### 🔊 内置合成器与播放
- MIDI 卡片内直接播放：播放/暂停（无损续播）、进度、**实时音量滑块**、下载、拖拽导出
- **捏音色**（合成器面板，卡片"音色"按钮或底部工具栏打开）：
  - 双振荡器：正弦/方波/锯齿/三角 × 2，各自音高（±2 八度）、电平、失谐（合唱感）
  - ADSR 包络：起音 / 衰减 / 延音 / 释音
  - 滤波器：亮度（对数截止频率）、共鸣 Q、亮度包络扫频
  - 三段 EQ（低/中/高频 ±12dB）、颤音（速率/深度）、总音量
  - 6 个预设（温暖钢琴 / 梦幻长垫 / 电子主音 / 弹拨拨弦 / 合成贝斯 / 弦乐合奏）+ 琶音试听
  - 设置自动保存；未开启自定义时按 GM 音色智能映射（同样走合成器引擎）
- CC11 表情曲线与延音踏板在播放中真实还原

### ⚙️ 可配置
- **模型服务**：任意 OpenAI 兼容接口（MiniMax / DeepSeek / OpenAI / Ollama / one-api…），多配置管理、连接测试、温度与 Token 上限
- **MCP 服务**：内置 MIDI MCP 工具（`create_midi` / `analyze_midi` / `modify_midi` / `list_midis`）；支持接入外部 MCP 服务器（stdio / HTTP(Streamable)），可视化状态与工具列表
- **知识库**：导入本地 txt / md / pdf / 代码等文件（或整个文件夹），BM25 中英文混合检索；聊天开启"知识库"后自动注入相关内容
- 会话管理（本地持久化）、深色主题、中文界面

## 快速开始

```bash
# 1. 安装依赖（建议 Node 18+）
npm install

# 2. 构建并启动
npm start

# 或开发模式（vite 热更新 + electron）
npm run dev

# 生产模式单独构建
npm run build
```

### 打包 Windows EXE

```bash
npm run dist          # NSIS 安装版 + Portable 单文件版（输出到 release/）
npm run dist:dir      # 仅解包目录版（release/win-unpacked/）
```

产物：
- `release/SuperMidiAgent Setup 0.1.0.exe` — 安装向导版（可选安装目录、创建桌面快捷方式）
- `release/SuperMidiAgent-Portable-0.1.0.exe` — 免安装单文件版，双击即用

首次使用：左下角 **设置 → 模型服务 → 添加模型服务**，填入任意 OpenAI 兼容服务：

| 字段 | 示例 |
| --- | --- |
| Base URL | `https://api.minimax.cn/v1` |
| API Key | `sk-...` |
| 模型 | `MiniMax-M3` |

## 使用示例

```
你：请生成一段 C 大调、120bpm、8 小节的钢琴旋律，要有乐句起伏
AI：（调用 create_midi 逐音符创作）→ 出现可播放/下载/拖拽的 MIDI 卡片

你：（拖入 song.mid）分析一下这个文件
AI：（调用 analyze_midi）→ 调性 G 大调、和弦进行 G-D-Em-C、力度平直、无 CC11…

你：给这个 MIDI 增加真实的力度和 CC11
AI：（调用 modify_midi: humanize_velocity + add_cc11）→ 新版本卡片
```

## 架构

```
src/
├─ shared/            # 主/渲染进程共享
│  ├─ midi/           #   SMF 解析器·写入器·时序·和弦·分析·人性化算法（纯 TS，无依赖）
│  └─ types.ts        #   IPC 通道与类型
├─ main/              # Electron 主进程
│  ├─ index.ts        #   窗口 / IPC（含原生拖拽导出 startDrag）
│  ├─ agentService.ts #   Agent 循环：系统提示 + 流式调用 + 工具执行
│  ├─ openaiClient.ts #   OpenAI 兼容 SSE 流式客户端（tool_calls 增量拼接、reasoning、<think> 过滤）
│  ├─ mcpManager.ts   #   内置(InMemory) + 外部(stdio/HTTP) MCP 连接管理
│  ├─ builtinMidiServer.ts # 内置 MIDI MCP 服务（zod schema + 4 个工具）
│  ├─ midiStore.ts    #   MIDI 资产存储（内存 + 磁盘持久化）
│  ├─ knowledgeBase.ts#   知识库（分块 + BM25）
│  └─ settingsStore.ts#   设置持久化
├─ preload/           # contextBridge 类型安全 API
└─ renderer/          # React UI
   ├─ components/     #   AntDX 聊天面板 / MIDI 卡片 / 钢琴卷帘 / 设置抽屉
   ├─ audio/          #   WebAudio 合成播放器（多音色 / CC11 / 延音踏板）
   └─ store.ts        #   zustand 会话状态 + wire 消息构建
```

## 测试

```bash
# 单元测试（62+ 用例：SMF round-trip、和弦/调性检测、人性化、BM25、SSE 解析、Agent 循环、MCP 协议）
npm test

# 真实 API 集成测试（需在 tests/live/agent-live.test.ts 中配置 token，或用环境变量 TEST_API_KEY/TEST_MODEL/TEST_BASE_URL）
npm run test:live

# GUI 端到端测试（先 npm start 后另开终端；或带 --remote-debugging-port=9222 启动）
npm start -- --remote-debugging-port=9222
node scripts/gui-test.mjs
```

## 常见问题

- **播放没声音**：检查系统音量；播放由首次点击触发（浏览器自动播放策略）。
- **外部 MCP（stdio）连不上**：确认命令在本机可直接执行（如 `npx` 需 Node 环境）；查看设置里的错误信息。
- **拖拽到桌面没反应**：按住卡片上的"拖到桌面"按钮拖动即可；应用需保持前台。
- 数据目录：`%APPDATA%/SuperMidiAgent/`（设置、MIDI 资产、知识库索引）。
