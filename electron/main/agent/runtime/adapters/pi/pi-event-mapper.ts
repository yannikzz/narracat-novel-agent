/**
 * Pi 事件 → App 归一化 AgentEvent 无状态映射（阶段 2 切片②）。
 * 语义对照 claude-sdk event-mapper：deltas 流式透出、工具生命周期、终态收口。
 * 与 SDK 侧的关键差异：
 * - Pi 的 agent_end 不带 usage/终态语义，run 级聚合由会话桥（pi-session）完成，桥在流尾
 *   追加合成消息 narracat_pi_run_end / narracat_pi_max_turns，本映射器翻成 run.completed/run.failed
 *   ——满足 run-manager「流尽必须见过终态事件」的收口契约。
 * - message_end stopReason='aborted' 刻意不产出：用户取消由 run-manager cancelling 分支发
 *   run.cancelled，与 SDK 路径 AbortError 语义拉平。
 * - 全文本类 message_end 不重发正文：Pi 恒有 text_delta 流，无 SDK「result 兜底全文」问题。
 */
import type { AgentEvent, AgentTokenUsage } from '@shared/types/agent'
import type { RuntimeMapContext } from '../../types.ts'

type UnknownRecord = Record<string, unknown>

export const PI_RUN_END_MESSAGE_TYPE = 'narracat_pi_run_end'
export const PI_MAX_TURNS_MESSAGE_TYPE = 'narracat_pi_max_turns'
/**
 * 子会话事件的包裹消息类型（切片⑤）。与上面两个合成消息类型同住本文件是为了断掉模块环：
 * pi-subagent → pi-session → pi-event-mapper 是单向依赖链，若该常量落在 pi-subagent.ts 再被
 * 本文件 import 就会成环。对外契约仍从 pi-subagent.ts re-export（消费者只认那一个导入点）。
 */
export const PI_SUBAGENT_EVENT_MESSAGE_TYPE = 'narracat_pi_subagent_event'

export const PI_SESSION_MESSAGE_TYPE = 'narracat_pi_session'

/**
 * 子会话异常终止（stopReason='length' / 'error'）时 Task 工具在结果 details 上打的标记。
 * pi 的 AgentToolResult 没有 isError 字段，工具唯一的失败通道是 throw——但 throw 会连同已产出
 * 部分与质量门反馈一起丢掉，于是走 details 侧信道分两路收口：交回模型的结果文本带 ⚠️ 前缀（主
 * 会话据此确定性重派），交给 UI 的任务卡则映射成 tool.failed。
 * 键名带 narracat 前缀避免与任何第三方工具的 details 撞名（本映射对全部工具生效）。
 *
 * UI 上的实际口径（别过度承诺）：tool.failed 复用工具级失败的既有通用呈现——执行过程流里逐项徽章
 * 是「失败」+ 失败原因（展开可见），而不是「完成」；折叠态汇总行读作「执行过程已完成 · N 项
 * （M 次失败）」，如实计次但不升级成 run 级红色告警（#37 刀②改的就是这句措辞，原文「自动调整
 * M 次」把报错说成了 agent 的主动优化，见 AgentProcessStream.tsx）。仍未做的是把失败原因提到
 * 折叠态——那要动汇总行信息密度，不在本刀范围。渲染端断言见
 * src/components/workbench/agent/AgentSubagentAbnormalStop.test.tsx。
 */
export type PiSubagentAbnormalStop = 'length' | 'error'
export interface PiSubagentAbnormalStopDetails {
  narracatSubagentAbnormalStop: PiSubagentAbnormalStop
}

/** 会话桥在持久化会话建立后首发的合成消息（切片⑦）：只供 adapter readSessionId 消费——
 * run-manager 借它把 session id 记进 sdkSessionsByThread（resume 消费面），不映射任何 AgentEvent。 */
export interface PiSessionMessage {
  type: typeof PI_SESSION_MESSAGE_TYPE
  sessionId: string
}

/** 会话桥在自然完结时追加的合成终态消息（usage 已聚合为 App 口径）。 */
export interface PiRunEndMessage {
  type: typeof PI_RUN_END_MESSAGE_TYPE
  usage?: AgentTokenUsage
}

/** 会话桥在回合预算触顶中止后追加的合成终态消息。 */
export interface PiMaxTurnsMessage {
  type: typeof PI_MAX_TURNS_MESSAGE_TYPE
}

const MAX_TURNS_ERROR_TEXT = 'Agent 本次运行达到回合上限，请稍后重试或提高运行上限。'
const RUN_FAILED_FALLBACK_TEXT = 'Pi runtime 运行失败。'
const TOOL_FAILED_FALLBACK_TEXT = '工具调用失败'
/** stopReason='length'（单次回复触输出上限被截断）fail-loud 文案：截断稿静默入库是写作链最坏
 * 路径，宁可失败重试（生产接线门前项①）。 */
const LENGTH_TRUNCATED_ERROR_TEXT = '模型单次回复长度达到上限，本次运行已中止，请重试或把任务拆小。'
/** 子会话异常终止时任务卡的失败文案：区分 length / error，事后能从落盘事件查出是哪一种。 */
const SUBAGENT_ABNORMAL_STOP_ERROR_TEXT: Record<PiSubagentAbnormalStop, string> = {
  length: '子 agent 单次回复达到输出上限被截断，本次派发未完成，请重试或把任务拆小。',
  error: '子 agent 因模型或服务端错误异常终止，本次派发未完成。',
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function readNumber(record: UnknownRecord, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}

/** narracat_pi_run_end.usage 逐字段读取（对齐 claude-sdk event-mapper.ts mapTokenUsage 写法）：
 * 桥已在 pi-session.ts 侧做过一遍数值校验构造，这里再逐字段收，不对 message.usage 整体断言。 */
function mapUsage(value: unknown): AgentTokenUsage | undefined {
  if (!isRecord(value)) return undefined

  const usage: AgentTokenUsage = {}
  const inputTokens = readNumber(value, 'inputTokens')
  const outputTokens = readNumber(value, 'outputTokens')
  const cacheReadTokens = readNumber(value, 'cacheReadTokens')
  const cacheCreationTokens = readNumber(value, 'cacheCreationTokens')

  if (inputTokens !== undefined) usage.inputTokens = inputTokens
  if (outputTokens !== undefined) usage.outputTokens = outputTokens
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens
  if (cacheCreationTokens !== undefined) usage.cacheCreationTokens = cacheCreationTokens

  return Object.keys(usage).length > 0 ? usage : undefined
}

/** Pi 工具结果 content（TextContent|ImageContent 数组）拼成纯文本；无文本返回 undefined。 */
function readToolResultText(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined
  const text = result.content
    .map((item) => (isRecord(item) && typeof item.text === 'string' ? item.text : ''))
    .join('')
  return text || undefined
}

function mapMessageUpdate(context: RuntimeMapContext, message: UnknownRecord): AgentEvent[] {
  const sub = message.assistantMessageEvent
  if (!isRecord(sub) || typeof sub.delta !== 'string') return []

  if (sub.type === 'text_delta') {
    return [
      {
        type: 'message.delta',
        runId: context.runId,
        messageId: context.messageId,
        text: sub.delta,
        createdAt: context.createdAt,
      },
    ]
  }

  if (sub.type === 'thinking_delta') {
    return [
      {
        type: 'reasoning.delta',
        runId: context.runId,
        messageId: context.messageId,
        text: sub.delta,
        createdAt: context.createdAt,
      },
    ]
  }

  return []
}

function mapToolExecutionStart(context: RuntimeMapContext, message: UnknownRecord): AgentEvent[] {
  const toolCallId = readString(message, 'toolCallId')
  const toolName = readString(message, 'toolName')
  if (!toolCallId || !toolName) return []

  const event: AgentEvent = {
    type: 'tool.started',
    runId: context.runId,
    messageId: context.messageId,
    toolCallId,
    toolName,
    title: `调用 ${toolName}`,
    createdAt: context.createdAt,
  }
  if (isRecord(message.args)) event.input = message.args
  return [event]
}

/** Task 工具结果 details 上的子会话异常终态标记（无标记/非法值返回 undefined）。 */
function readSubagentAbnormalStop(result: unknown): PiSubagentAbnormalStop | undefined {
  if (!isRecord(result) || !isRecord(result.details)) return undefined
  const value = result.details.narracatSubagentAbnormalStop
  return value === 'length' || value === 'error' ? value : undefined
}

function mapToolExecutionEnd(context: RuntimeMapContext, message: UnknownRecord): AgentEvent[] {
  const toolCallId = readString(message, 'toolCallId')
  if (!toolCallId) return []

  const text = readToolResultText(message.result)
  // 子会话异常终止对 pi 是「工具正常返回」，只有 details 标记能揭穿——不认这一层，跑满几分钟却
  // 什么都没干成的派发就会挂着「完成」徽章、失败原因一个字都不显示（#29）。
  const abnormalStop = readSubagentAbnormalStop(message.result)
  if (message.isError === true || abnormalStop) {
    return [
      {
        type: 'tool.failed',
        runId: context.runId,
        toolCallId,
        error: abnormalStop ? SUBAGENT_ABNORMAL_STOP_ERROR_TEXT[abnormalStop] : (text ?? TOOL_FAILED_FALLBACK_TEXT),
        createdAt: context.createdAt,
      },
    ]
  }

  const event: AgentEvent = {
    type: 'tool.completed',
    runId: context.runId,
    toolCallId,
    createdAt: context.createdAt,
  }
  if (text) event.result = text
  return [event]
}

function mapMessageEnd(context: RuntimeMapContext, message: UnknownRecord): AgentEvent[] {
  const inner = message.message
  if (!isRecord(inner)) return []

  // 'length' = 单次回复触输出上限被截断：不能当自然完结（截断稿静默入库），映射 run.failed 收口；
  // 桥侧同步把它计入 sawErrorStop，不再补发 run_end（与 'error' 分支互斥语义同构）。
  if (inner.stopReason === 'length') {
    return [
      {
        type: 'run.failed',
        runId: context.runId,
        error: LENGTH_TRUNCATED_ERROR_TEXT,
        createdAt: context.createdAt,
      },
    ]
  }

  if (inner.stopReason !== 'error') return []

  return [
    {
      type: 'run.failed',
      runId: context.runId,
      error: readString(inner, 'errorMessage') ?? RUN_FAILED_FALLBACK_TEXT,
      createdAt: context.createdAt,
    },
  ]
}

/**
 * 子会话事件（经 Task 工具包裹后由事件桥排出）→ 带归属的工具事件。
 * 只透出工具生命周期：子会话文本/思考不映射（不污染主对话转录，最终文本走 Task 工具结果通道），
 * 子会话终态也不映射（终态语义归父 run；子会话失败已由 Task 工具结果的 isError 表达）。
 */
function mapSubagentEvent(context: RuntimeMapContext, message: UnknownRecord): AgentEvent[] {
  const parentToolCallId = readString(message, 'parentToolCallId')
  const inner = message.message
  if (!parentToolCallId || !isRecord(inner)) return []

  if (inner.type === 'tool_execution_start') {
    return mapToolExecutionStart(context, inner).map((event) => ({ ...event, parentToolCallId }))
  }
  if (inner.type === 'tool_execution_end') {
    return mapToolExecutionEnd(context, inner).map((event) => ({ ...event, parentToolCallId }))
  }
  return []
}

export function mapPiMessageToAgentEvents(context: RuntimeMapContext, message: unknown): AgentEvent[] {
  if (!isRecord(message)) return []

  // 会话 id 合成消息走 readSessionId 侧信道，对事件流零产出（显式钉住契约，虽然默认分支也返回空）。
  if (message.type === PI_SESSION_MESSAGE_TYPE) return []
  if (message.type === PI_SUBAGENT_EVENT_MESSAGE_TYPE) return mapSubagentEvent(context, message)
  if (message.type === 'message_update') return mapMessageUpdate(context, message)
  if (message.type === 'tool_execution_start') return mapToolExecutionStart(context, message)
  if (message.type === 'tool_execution_end') return mapToolExecutionEnd(context, message)
  if (message.type === 'message_end') return mapMessageEnd(context, message)

  if (message.type === PI_RUN_END_MESSAGE_TYPE) {
    const event: AgentEvent = {
      type: 'run.completed',
      runId: context.runId,
      createdAt: context.createdAt,
    }
    const usage = mapUsage(message.usage)
    if (usage) event.usage = usage
    return [event]
  }

  if (message.type === PI_MAX_TURNS_MESSAGE_TYPE) {
    return [
      {
        type: 'run.failed',
        runId: context.runId,
        error: MAX_TURNS_ERROR_TEXT,
        // 机器可读终态（拆旧刀2）：与 SDK error_max_turns 同契约，消费方靠它分流「可续的截断」
        reason: 'max-turns',
        createdAt: context.createdAt,
      },
    ]
  }

  return []
}
