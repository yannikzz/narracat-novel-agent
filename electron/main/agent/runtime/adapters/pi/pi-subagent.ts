/**
 * Pi 子 agent 派发 + 任务卡（阶段 2 切片⑤）：SDK 侧 `Task` 内置工具与 SubagentStop 钩子在 pi 的重建件。
 *
 * 形态 = **进程内嵌套会话**（spec §2 方案 A）：`Task` 自定义工具的 execute 里再跑一遍 `runPiSession`，
 * 子会话的工具面/系统词由引擎 agent 注册表给定，权限 guard 与引擎钩子由装配方（index.ts）整份继承。
 * 弃 pi 官方 spawn 子进程示例——打包后的 Electron 没有可 spawn 的 pi CLI。
 *
 * 三条纪律：
 * - **无递归**：子会话 customTools 恒空（装配方保证），子 agent 不能再派子 agent、不驱动主会话任务卡。
 * - **故障隔离**：execute 全链 try/catch，子会话任何异常收敛成本次工具调用的 isError 结果（pi agent-loop
 *   把 throw 转成 isError 工具结果），run 不崩。
 * - **归属可观测**：子会话每条事件包成 PiSubagentEventMessage 推进 run 级 channel，由事件桥排进父 run 的
 *   消息流，映射器据 parentToolCallId 折叠成分组卡（pi-event-mapper.ts）。
 */
import { defineTool } from '@mariozechner/pi-coding-agent'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { Type } from 'typebox'
import { NARRACAT_ENGINE_AGENT_IDS } from '../../../../engine/agent-core-contract.ts'
import type { EngineAgentDefinition } from '../../../../engine/engine-agent-registry.ts'
import { PI_MAX_TURNS_MESSAGE_TYPE, PI_SUBAGENT_EVENT_MESSAGE_TYPE } from './pi-event-mapper.ts'
import type { PiSubagentAbnormalStop, PiSubagentAbnormalStopDetails } from './pi-event-mapper.ts'
import type { PiThinkingMode } from './pi-model.ts'
import { runPiSession } from './pi-session.ts'
import type { PiRunOptions } from './pi-session.ts'

export const TASK_TOOL_NAME = 'Task'
export const TASK_CREATE_TOOL_NAME = 'TaskCreate'
export const TASK_UPDATE_TOOL_NAME = 'TaskUpdate'
/** 对外唯一导入点（常量本体住 pi-event-mapper.ts 以断模块环，见那边注释）。 */
export { PI_SUBAGENT_EVENT_MESSAGE_TYPE }

/** 进程内并发派发上限（照 pi 官方 subagent 示例的编排常数）：超出的 execute 排 FIFO 队列。 */
const DEFAULT_MAX_CONCURRENCY = 4
const MAX_TURNS_RESULT_PREFIX = '⚠️ 子 agent 达到回合上限，以下为已完成部分：'
/**
 * 子会话异常终止的结果前缀（与 MAX_TURNS_RESULT_PREFIX 同构）：不加这层，异常终止与「正常结束但
 * 没产出 text 块」在主会话看来完全一样，都是下面那句 EMPTY_RESULT_TEXT——真机上跑满四分钟、烧掉
 * 整章 token 却什么都没干成的派发就这么被当成「干完了不爱说话」放行（#29）。
 */
const ABNORMAL_STOP_RESULT_PREFIX: Record<PiSubagentAbnormalStop, string> = {
  length: '⚠️ 子 agent 单次回复达到输出上限被截断，本次派发未完成，交付不可信：请核实产物，按需重新派发或把任务拆小。以下为已产出部分：',
  error: '⚠️ 子 agent 因模型或服务端错误异常终止，本次派发未完成，交付不可信：请核实产物后重新派发。以下为已产出部分：',
}
const EMPTY_RESULT_TEXT = '（子 agent 未产出文本）'
const ABORTED_ERROR_TEXT = '子 agent 任务已随主任务中止'
/** `Task(narracat:x)` 与 `Task(x)` 两种写法都认（命令文本里的命名空间前缀零改动）。 */
const NAMESPACE_PREFIX = /^narracat:/

export interface PiSubagentEventMessage {
  type: typeof PI_SUBAGENT_EVENT_MESSAGE_TYPE
  parentToolCallId: string
  agentId: string
  /** 子会话 runPiSession 原样透出的 pi 事件或合成终态消息 */
  message: unknown
}

export interface PiSubagentEventChannel {
  push(message: PiSubagentEventMessage): void
  subscribe(listener: (message: PiSubagentEventMessage) => void): () => void
}

/**
 * run 级子会话事件汇：push 同步广播，订阅前的消息不重放——装配顺序（index.ts 先建 channel 随
 * PiRunOptions 传给事件桥、桥在 prompt 前订阅，Task 工具要等模型调用才 push）保证不丢事件。
 */
export function createSubagentEventChannel(): PiSubagentEventChannel {
  const listeners = new Set<(message: PiSubagentEventMessage) => void>()
  return {
    push(message) {
      // 复制一份再遍历：监听器在回调里退订（事件桥 finally）不会打乱本次广播。
      for (const listener of [...listeners]) listener(message)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export interface CreateTaskToolArgs {
  loadDefinitions: () => Promise<Record<string, EngineAgentDefinition>>
  buildChildRunOptions: (
    definition: EngineAgentDefinition,
    childAbort: AbortController,
    thinking: PiThinkingMode,
  ) => PiRunOptions
  channel: PiSubagentEventChannel
  parentSignal: AbortSignal
  /** 出稿/回执质量门（Task 6 runSubagentGate）：返回追加进结果的反馈行；恒不阻断，异常吞掉。 */
  gate?: (agentId: string, cwd: string) => Promise<string[]>
  cwd: string
  /** DI 接缝：单测注入假子会话生成器（真会话要打网络）。 */
  runSession?: typeof runPiSession
  maxConcurrency?: number
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** assistant `message_end` 的 content 数组里的 text 块拼成一段（非 text 块忽略）。 */
function readAssistantText(message: UnknownRecord): string | undefined {
  const inner = message.message
  if (!isRecord(inner) || inner.role !== 'assistant' || !Array.isArray(inner.content)) return undefined
  const text = inner.content
    .map((item) => (isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : ''))
    .join('')
  return text || undefined
}

/**
 * assistant `message_end` 的异常终态（'length' 输出截断 / 'error' 模型或服务端报错）。
 * 'aborted' 不算异常终态：中止由 childAbort 分支报错收口，与父会话映射器口径一致。
 */
function readAbnormalStop(message: UnknownRecord): PiSubagentAbnormalStop | undefined {
  const inner = message.message
  if (!isRecord(inner) || inner.role !== 'assistant') return undefined
  const stopReason = inner.stopReason
  return stopReason === 'length' || stopReason === 'error' ? stopReason : undefined
}

/** 并发闸：计数器 + FIFO 唤醒队列。while 复检而非唤醒即占位，避免唤醒与新 acquire 抢同一个名额。 */
function createConcurrencyGate(limit: number) {
  let running = 0
  const waiters: Array<() => void> = []
  return {
    async acquire(): Promise<void> {
      while (running >= limit) {
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
      running += 1
    },
    release(): void {
      running -= 1
      waiters.shift()?.()
    },
  }
}

const taskToolSchema = Type.Object({
  subagent_type: Type.String({ description: '子 agent 名，如 chapter-writer（narracat: 前缀可带可不带）' }),
  prompt: Type.String({ description: '交给子 agent 的完整任务描述（子会话不共享主会话上下文，须自足）' }),
  thinking: Type.Optional(
    Type.String({
      description:
        "子会话思考档：'off' = 关闭思考，只给低自由度任务用（输入已给定完整素材、只做打磨或按清单定点修改）；省略或其它值 = 保持模型默认。拿不准就省略。",
    }),
  ),
})

export function createTaskTool({
  loadDefinitions,
  buildChildRunOptions,
  channel,
  parentSignal,
  gate,
  cwd,
  runSession = runPiSession,
  maxConcurrency = DEFAULT_MAX_CONCURRENCY,
}: CreateTaskToolArgs): ToolDefinition {
  // 注册表解析 promise 只跑一次（同一 run 内多次派发共用）。
  let definitionsPromise: Promise<Record<string, EngineAgentDefinition>> | undefined
  const load = () => (definitionsPromise ??= loadDefinitions())
  const gateConcurrency = createConcurrencyGate(maxConcurrency)

  return defineTool({
    name: TASK_TOOL_NAME,
    label: '派发子 agent',
    description:
      '把一段独立子任务派发给专职子 agent 执行（独立上下文、收窄工具面），完成后把结果文本交回。可用子 agent：' +
      NARRACAT_ENGINE_AGENT_IDS.join('、'),
    promptSnippet: `Task: 派发子 agent（${NARRACAT_ENGINE_AGENT_IDS.join(' / ')}）执行独立子任务`,
    // write 命令第 5 步一次并行派发多个 memory-keeper 是既有契约；进程内并发上限见 maxConcurrency。
    executionMode: 'parallel',
    parameters: taskToolSchema,
    async execute(toolCallId, params, signal) {
      const agentId = String(params.subagent_type ?? '').replace(NAMESPACE_PREFIX, '')
      // 只认 'off' 这一个值，其余（省略、拼错、模型自由发挥）一律回落 provider 默认——失败方向
      // 朝着「维持现状」，漏传/传错最多是没省下 token，不会把某个环节的思考悄悄关掉。
      const thinking: PiThinkingMode = params.thinking === 'off' ? 'off' : 'provider-default'
      try {
        const definitions = await load()
        const definition = definitions[agentId]
        if (!definition) {
          throw new Error(`未知子 agent「${agentId}」，可用：${Object.keys(definitions).join('、')}`)
        }

        // 信号桥：父 run signal 与工具级 signal 任一 abort → 子会话立即中止。已 abort 的信号
        // 不会再发事件，须先查一次 aborted（否则监听器永远等不到那次已经发生的 abort）。
        const childAbort = new AbortController()
        const abortChild = () => childAbort.abort()
        const upstream = [parentSignal, signal].filter((s): s is AbortSignal => Boolean(s))
        for (const upstreamSignal of upstream) {
          if (upstreamSignal.aborted) abortChild()
          else upstreamSignal.addEventListener('abort', abortChild, { once: true })
        }

        await gateConcurrency.acquire()
        let finalText = ''
        let maxTurnsTripped = false
        // 与 maxTurnsTripped 同为「一旦命中就粘住」：任何一轮撞上截断/报错，这一遍交付就已不可信，
        // 后续正常收笔不该把它洗回成功。
        let abnormalStop: PiSubagentAbnormalStop | undefined
        try {
          for await (const message of runSession({
            prompt: String(params.prompt ?? ''),
            options: buildChildRunOptions(definition, childAbort, thinking),
          })) {
            channel.push({ type: PI_SUBAGENT_EVENT_MESSAGE_TYPE, parentToolCallId: toolCallId, agentId, message })
            if (!isRecord(message)) continue
            if (message.type === 'message_end') {
              // 多轮会有多条 assistant message_end，最后一条非空的才是子 agent 的交付文本。
              const text = readAssistantText(message)
              if (text) finalText = text
              // 子会话终态只在这里可见：pi-session 的桥虽已判出 sawErrorStop，那是它的 run 级私有
              // 状态，而映射器服务的是父 run 的事件流——子会话路径上没人接这层信号。
              abnormalStop ??= readAbnormalStop(message)
              continue
            }
            if (message.type === PI_MAX_TURNS_MESSAGE_TYPE) maxTurnsTripped = true
          }
        } finally {
          gateConcurrency.release()
          for (const upstreamSignal of upstream) upstreamSignal.removeEventListener('abort', abortChild)
        }

        if (childAbort.signal.aborted) throw new Error(ABORTED_ERROR_TEXT)

        const parts: string[] = []
        if (abnormalStop) {
          // 这个信号此前不落任何地方（#29「未确认项」正是因此无从复盘）：主进程日志留一条，
          // 事后能查出是 length 还是 error。
          console.warn(`[narracat] pi 子 agent 异常终止（stopReason=${abnormalStop}）：${agentId}`)
          parts.push(ABNORMAL_STOP_RESULT_PREFIX[abnormalStop])
        }
        if (maxTurnsTripped) parts.push(MAX_TURNS_RESULT_PREFIX)
        parts.push(finalText || EMPTY_RESULT_TEXT)
        if (gate) {
          let feedback: string[] = []
          try {
            feedback = await gate(agentId, cwd)
          } catch (error) {
            // 质量门恒不阻断（spec §4）：判据自身炸了只留警示，结果照常回流。
            console.warn(`[narracat] pi 子 agent 质量门异常（fail-open）：${agentId}`, error)
          }
          if (feedback.length > 0) parts.push(feedback.join('\n'))
        }
        // details 是给 UI 的侧信道（见 PiSubagentAbnormalStopDetails，那里记着 UI 上的确切口径）：
        // 模型收到的是带 ⚠️ 前缀的成功结果（保住已产出部分与质量门反馈），任务卡则据此收口成
        // tool.failed——逐项呈现从「完成」变「失败」+ 失败原因，不再一声不吭地放行。
        const details: PiSubagentAbnormalStopDetails | undefined = abnormalStop
          ? { narracatSubagentAbnormalStop: abnormalStop }
          : undefined
        return { content: [{ type: 'text', text: parts.join('\n\n') }], details }
      } catch (error) {
        // agent-loop 把 throw 转成 isError 工具结果，主会话可改派/补救，run 不崩（spec §2.2 故障隔离）。
        console.warn(`[narracat] pi 子 agent 派发失败：${agentId}`, error)
        throw error
      }
    },
  }) as ToolDefinition
}

const taskCreateSchema = Type.Object({
  subject: Type.String({ description: '任务标题（一句话，展示在工作台步骤卡上）' }),
  description: Type.Optional(Type.String({ description: '任务补充说明' })),
  activeForm: Type.Optional(Type.String({ description: '进行时表述，如「正在聚合上下文」' })),
})

const taskUpdateSchema = Type.Object({
  taskId: Type.Union([Type.String(), Type.Number()], { description: 'TaskCreate 返回的任务编号' }),
  status: Type.Optional(Type.String({ description: 'pending / in_progress / completed / failed / deleted' })),
  subject: Type.Optional(Type.String({ description: '改写任务标题' })),
})

/**
 * 任务卡两件套：run 级闭包只负责发号与回执文本，**任务列表本身不在这里聚合**——sink 层从
 * TaskCreate/TaskUpdate 的 `tool.started` 输入增量聚合成 `task-plan.updated`（agent/events/
 * task-plan-from-tools.ts，两 runtime 共用一条路径）。故字段名 subject/description/taskId/status
 * 是与 sink 的硬契约，改名即断链。
 */
export function createTaskCardTools(): ToolDefinition[] {
  let count = 0

  const create = defineTool({
    name: TASK_CREATE_TOOL_NAME,
    label: '创建任务',
    description: '为本次工作登记一条任务，用户可在工作台看到进度。',
    promptSnippet: 'TaskCreate: 登记一条任务到工作台任务列表',
    parameters: taskCreateSchema,
    async execute(_toolCallId, params) {
      // 拒绝条件必须与 sink 逐字对齐（applyTaskToolCall 对空白 subject return null 不建卡）：
      // 这里若照发号，工具回执的 #N 与 sink 的 max(id)+1 就永久错位，之后每条 TaskUpdate 都会
      // 因 taskId 找不到被 sink 静默丢弃 —— 空白 subject 直接 throw，两侧发号始终同步。
      if (typeof params.subject !== 'string' || !params.subject.trim()) {
        throw new Error('TaskCreate 需要非空 subject（任务标题）')
      }
      count += 1
      return { content: [{ type: 'text', text: `任务 #${count} 已创建` }], details: undefined }
    },
  }) as ToolDefinition

  const update = defineTool({
    name: TASK_UPDATE_TOOL_NAME,
    label: '更新任务',
    description: '更新已登记任务的状态或标题（status：pending / in_progress / completed / failed / deleted）。',
    promptSnippet: 'TaskUpdate: 更新工作台任务列表里某条任务的状态',
    parameters: taskUpdateSchema,
    async execute(_toolCallId, params) {
      return { content: [{ type: 'text', text: `任务 #${params.taskId} 已更新` }], details: undefined }
    },
  }) as ToolDefinition

  return [create, update]
}
