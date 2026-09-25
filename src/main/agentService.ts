/** Agent 执行循环：系统提示词组装 + 流式模型调用 + MCP 工具执行。 */
import { AgentEvent, ModelProfile, WireMessage, MidiAssetMeta } from '../shared/types';
import { streamChat, ToolDef, LlmError, ChatMessageLike } from './openaiClient';
import { McpManager } from './mcpManager';
import { KnowledgeBase } from './knowledgeBase';
import { MidiStore } from './midiStore';
import { GM_PROGRAM_NAMES } from './gmPrograms';

export interface AgentDeps {
  mcp: McpManager;
  kb: KnowledgeBase;
  midiStore: MidiStore;
}

export interface RunParams {
  runId: string;
  sessionId: string;
  messages: WireMessage[];
  profile: ModelProfile;
  kbEnabled: boolean;
  maxIterations: number;
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
}

export function buildSystemPrompt(opts: { sessionMidis: MidiAssetMeta[]; kbContext: string }): string {
  const lines: string[] = [];
  lines.push('你是 SuperMidiAgent，一个专业的 AI 音乐制作助手，精通乐理、和声、编曲与 MIDI 制作。用户通过对话框与你协作创作 MIDI 音乐。');
  lines.push('');
  lines.push('## 工作方式');
  lines.push('- 你可以通过内置 MCP 工具直接创建、分析和修改 MIDI。生成或修改成功后，聊天界面会自动展示可播放、下载的 MIDI 卡片。');
  lines.push('- 生成 MIDI 使用 create_midi：你必须亲自决定并给出每个音符的具体数据（音高、起始拍、时值拍、力度）。这是你的核心创作工作，要认真设计旋律与和声，而不是让用户补充细节。');
  lines.push('- 音符的 start/duration 以"拍"为单位（4/4 拍下 4 拍 = 1 小节，0.5 拍 = 八分音符，0.25 拍 = 十六分音符）。');
  lines.push('- 创作要点：旋律应服从调性、有清晰的乐句与呼吸（乐句间留空）、节奏以规整网格为主；力度要有起伏（70-110 之间变化，乐句高潮处更强），不要所有音都用同一力度。');
  lines.push('- 修改 MIDI 用 modify_midi（生成新版本，不覆盖原版）：增加真实力度用 humanize_velocity；表情/调制曲线用 auto_cc_curve（为任意 CC 自动生成乐句起伏，controller 参数选控制器号，min/max 指定 0-127 内的值域，如 min=0, max=64 做弱奏细节）；需要精确"画"CC 曲线（如"从 0 渐强到 110 再落回 20"）用 set_cc_curve，给出 {bar, beat, value} 控制点并选插值方式（smooth 平滑/linear 直线/step 阶梯）。两者都支持任意 CC 号：不同音源用的 CC 不同，常见的有 CC11 表情、CC1 调制/颤音、CC2 气息、CC74 亮度，按用户音源选择；改变和弦进行用 change_chords；还有 transpose、quantize、add_sustain、set_tempo、set_program 等操作。多个操作可以放在一次调用的 operations 数组中按顺序执行。');
  lines.push('- 在分析或修改前，若还不了解该 MIDI，先调用 analyze_midi 获取调性、和弦、力度与 CC 状态。');
  lines.push('- 工具返回中的 midiId 是 MIDI 的唯一标识，后续操作要引用它。可用 list_midis 查看当前全部 MIDI。');
  lines.push('- 完成工具调用后，用简洁的中文向用户总结你做了什么、音乐设计思路，以及可以继续尝试的方向。');
  lines.push('');
  lines.push('## GM 音色速查（program 编号）');
  lines.push('0 原声钢琴, 4 电钢琴, 11 颤音琴, 24 尼龙吉他, 25 钢弦吉他, 33 指弹贝斯, 40 小提琴, 48 弦乐合奏, 56 小号, 60 法国号, 65 高音萨克斯, 73 长笛, 80 合成主音');
  if (opts.sessionMidis.length > 0) {
    lines.push('');
    lines.push('## 当前会话已有 MIDI');
    for (const m of opts.sessionMidis) {
      lines.push(`- midiId=${m.id} 「${m.title}」 (${m.source === 'generated' ? '生成' : m.source === 'uploaded' ? '用户上传' : '修改版'}, ${m.barCount} 小节, ${m.noteCount} 音符, ${m.tempoBpm}bpm)`);
    }
  }
  if (opts.kbContext) {
    lines.push('');
    lines.push('## 知识库参考资料（来自用户知识库，与当前问题相关时使用）');
    lines.push(opts.kbContext);
  }
  return lines.join('\n');
}

export async function runAgent(params: RunParams, deps: AgentDeps): Promise<void> {
  const { runId, emit, profile, signal } = params;
  try {
    emit({ type: 'run_start', runId });

    // 知识库上下文
    let kbContext = '';
    if (params.kbEnabled) {
      const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
      if (lastUser?.content) {
        const hits = deps.kb.search(lastUser.content, 4);
        if (hits.length > 0) {
          kbContext = hits
            .map((h, i) => `[${i + 1}] (${h.title})\n${h.text}`)
            .join('\n\n')
            .slice(0, 6000);
        }
      }
    }

    const sessionMidis = deps.midiStore.list(params.sessionId);
    const systemPrompt = buildSystemPrompt({ sessionMidis, kbContext });

    const toolRefs = deps.mcp.getToolsForLlm();
    const tools: ToolDef[] = toolRefs.map((t) => ({
      type: 'function' as const,
      function: { name: t.exposedName, description: t.description, parameters: t.inputSchema },
    }));

    // 规范化历史：去掉历史里损坏的 tool_calls 引用（例如上次异常中断留下的孤立 tool 消息）
    const apiMessages = sanitizeHistory(params.messages, systemPrompt);

    let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } = {};

    for (let iteration = 0; iteration < params.maxIterations; iteration++) {
      if (signal.aborted) throw new Error('已中止');
      if (iteration > 0) emit({ type: 'iteration', runId, index: iteration });

      const result = await streamChat(
        {
          baseUrl: profile.baseUrl,
          apiKey: profile.apiKey,
          model: profile.model,
          messages: apiMessages,
          tools,
          temperature: profile.temperature ?? 0.7,
          maxTokens: profile.maxTokens,
          topP: profile.topP,
          signal,
        },
        {
          onText: (delta) => emit({ type: 'text_delta', runId, delta }),
          onReasoning: (delta) => emit({ type: 'reasoning_delta', runId, delta }),
          onUsage: (u) => {
            usage = {
              promptTokens: u.prompt_tokens ?? usage.promptTokens,
              completionTokens: u.completion_tokens ?? usage.completionTokens,
              totalTokens: u.total_tokens ?? usage.totalTokens,
            };
          },
        },
      );

      if (result.toolCalls.length === 0) {
        emit({ type: 'done', runId, finishReason: result.finishReason ?? 'stop', usage });
        return;
      }

      // 记录 assistant 工具调用消息
      apiMessages.push({
        role: 'assistant',
        content: result.content || null,
        tool_calls: result.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: tc.function })),
      });

      for (const tc of result.toolCalls) {
        if (signal.aborted) throw new Error('已中止');
        let args: Record<string, unknown> = {};
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          args = {};
        }
        emit({ type: 'tool_start', runId, toolCallId: tc.id, toolName: tc.function.name, argsJson: tc.function.arguments.slice(0, 800) });

        const { text, isError } = await deps.mcp.callTool(tc.function.name, args);
        const { cleanText, assets } = extractAssets(text, deps.midiStore);
        emit({
          type: 'tool_end',
          runId,
          toolCallId: tc.id,
          toolName: tc.function.name,
          ok: !isError,
          summary: summarizeToolResult(cleanText, isError),
          midiAssets: assets,
          resultPreview: cleanText.slice(0, 1500),
        });
        apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: cleanText.slice(0, 12000) });
      }
    }

    emit({ type: 'done', runId, finishReason: 'max_iterations', usage });
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      emit({ type: 'done', runId, finishReason: 'aborted' });
      return;
    }
    const message = err instanceof LlmError ? err.message : err instanceof Error ? err.message : String(err);
    emit({ type: 'error', runId, message });
  }
}

/** 工具输出中包含 MIDI 资产时（仅 create/modify 返回 midiAsset 字段），附带完整元数据给渲染层。 */
function extractAssets(text: string, store: MidiStore): { cleanText: string; assets: MidiAssetMeta[] } {
  const assets: MidiAssetMeta[] = [];
  let parsed: { midiId?: string; midiAsset?: unknown } | null = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { cleanText: text, assets };
  }
  if (parsed && typeof parsed === 'object' && parsed.midiAsset && typeof parsed.midiId === 'string') {
    const found = store.get(parsed.midiId);
    if (found) assets.push(found.meta);
  }
  return { cleanText: text, assets };
}

function summarizeToolResult(text: string, isError: boolean): string {
  if (isError) return '执行失败';
  try {
    const obj = JSON.parse(text);
    if (typeof obj.message === 'string') return obj.message;
    if (obj.ok === true) return '执行成功';
  } catch {
    // 非 JSON
  }
  return text.slice(0, 120);
}

/** 历史消息规范化：过滤掉 tool_calls 缺失的孤立 tool 消息，注入系统提示。 */
export function sanitizeHistory(messages: WireMessage[], systemPrompt: string): ChatMessageLike[] {
  const out: ChatMessageLike[] = [{ role: 'system', content: systemPrompt }];
  // 有结果回应的 tool_call id
  const answered = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id) answered.add(msg.tool_call_id);
  }
  const expectedToolResults = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      const kept = msg.tool_calls.filter((tc) => answered.has(tc.id));
      if (kept.length > 0) {
        out.push({
          role: 'assistant',
          content: msg.content ?? '',
          tool_calls: kept.map((tc) => ({ id: tc.id, type: 'function', function: tc.function })),
        });
        for (const tc of kept) expectedToolResults.add(tc.id);
        continue;
      }
      if (msg.content) out.push({ role: 'assistant', content: msg.content });
      continue;
    }
    if (msg.role === 'tool') {
      if (msg.tool_call_id && expectedToolResults.has(msg.tool_call_id)) {
        out.push({ role: 'tool', tool_call_id: msg.tool_call_id, content: msg.content ?? '' });
        expectedToolResults.delete(msg.tool_call_id);
      }
      continue;
    }
    out.push({ role: msg.role, content: msg.content });
  }
  return out;
}

export { GM_PROGRAM_NAMES };
