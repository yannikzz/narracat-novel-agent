/**
 * Pi 进程内会话装配 + 事件桥（阶段 2 切片①，形态母本 = spike 报告存档脚本）。
 * 资源全隔离是硬纪律（spec §5.2）：AuthStorage/ModelRegistry/SessionManager/SettingsManager 全部
 * inMemory + resourceLoader 全替换 + agentDir 指 App 私有目录——防用户全局 ~/.pi 配置与小说目录
 * 杂散 AGENTS.md 漏进上下文（ADR-0028 纪律的 Pi 版，spike 金丝雀已实测零泄漏）。
 * key 经 setRuntimeApiKey 运行时注入，不落盘。
 */
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent'
import type { Model } from '@mariozechner/pi-ai'
import type { Extension, ToolDefinition } from '@mariozechner/pi-coding-agent'
import type { AgentTokenUsage } from '@shared/types/agent'
import { PI_MAX_TURNS_MESSAGE_TYPE, PI_REPEATED_TOOL_FAILURE_MESSAGE_TYPE, PI_RUN_END_MESSAGE_TYPE, PI_SESSION_MESSAGE_TYPE } from './pi-event-mapper.ts'
import type { PiMaxTurnsMessage, PiRepeatedToolFailureMessage, PiRunEndMessage, PiSessionMessage } from './pi-event-mapper.ts'
import { createRepeatedToolFailureTracker } from './pi-repeated-tool-failure.ts'
import { wrapStreamFnWithToolCallNameNormalizer } from './pi-toolcall-name-normalizer.ts'
import type { RepeatedToolFailure } from './pi-repeated-tool-failure.ts'
// 类型导入（编译期擦除）：pi-subagent 反向依赖本模块的 runPiSession，值导入会成环。
import type { PiSubagentEventChannel, PiSubagentEventMessage } from './pi-subagent.ts'

export interface PiRunOptions {
  model: Model<'anthropic-messages' | 'openai-completions'>
  provider: string
  apiKey: string
  cwd: string
  agentDir: string
  tools: string[]
  /** 回合预算（Pi 无内建 maxTurns，桥订阅 turn_end 计数，触顶 abort 并以合成消息收口）。 */
  maxTurns: number
  systemPrompt?: string
  /** 小说 AGENTS.md/CLAUDE.md 单文件精准注入（切片，ADR-0028）：只主会话传，经 getAppendSystemPrompt
   *  第二个受控口子注入；子会话（buildChildRunOptions）不传。 */
  systemPromptAppendix?: string
  abortController: AbortController
  /** 权限门禁合成扩展（tool_call guard）等：经 resourceLoader.getExtensions 注入（切片③）。 */
  extensions: Extension[]
  /** 自定义工具（AskUserQuestion 等）：经 createAgentSession customTools 注入（切片③）。 */
  customTools: ToolDefinition[]
  /** 子会话事件通道（切片⑤）：Task 工具把子会话事件推进来，本桥排进同一条消息流并并账 usage。 */
  subagentChannel?: PiSubagentEventChannel
  /**
   * 会话持久化（切片⑦）：主会话传 dir（App 私有目录）落 pi 原生 JSONL，resumeSessionId 续接既有
   * 会话；缺省（子会话派发）保持 in-memory，行为与切片⑥逐字节一致。持久化会话建立后本桥首发合成
   * 消息 narracat_pi_session 带 session id，供 adapter readSessionId 消费。
   */
  sessionStore?: { dir: string; resumeSessionId?: string }
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * DI 接缝：单测用假会话替换真 createAgentSession（真会话要打网络）。结构面只声明本桥用到的成员。
 * subscribe 返回类型留 unknown（而非收紧成 `() => void`）是故意的：真实 AgentSession.subscribe 确实
 * 返回 unsubscribe 函数（node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.d.ts:235），
 * 但假会话在部分测试里不需要返回值——运行时按"若为函数则调用"处理，两边都兼容。
 */
export interface PiSessionLike {
  subscribe(listener: (event: unknown) => void): unknown
  prompt(text: string): Promise<unknown>
  abort(): unknown
}
export type CreatePiSession = (
  args: Parameters<typeof createAgentSession>[0],
) => Promise<{ session: PiSessionLike }>

/** abort() 语义是尽力而为：中止失败不该冒泡给消费者（真实错误已经在 prompt 侧的 promptError 里透出）。 */
async function safeAbort(session: PiSessionLike): Promise<void> {
  try {
    await session.abort()
  } catch {
    // 吞掉——避免产生未处理 rejection，也避免掩盖 prompt 侧的真实错误
  }
}

const FALLBACK_SYSTEM_PROMPT =
  'You are the NarraCat agent runtime skeleton. Tools are restricted; follow instructions exactly.'

/**
 * 全替换 ResourceLoader：九个方法全空/定值，杜绝 Pi 默认的 ~/.pi、祖先 AGENTS.md、.agents/skills
 * 上溯读取（九方法全替换纪律不变）。两个受控口子：getExtensions（切片③，权限门禁合成扩展/
 * tool_call guard 从这里注入）+ getAppendSystemPrompt（本次，小说根单文件 AGENTS.md/CLAUDE.md
 * 精准注入，仅主会话传 appendix——见 pi/index.ts createRunOptions），其余七个方法仍是空集/定值。
 */
function createIsolatedResourceLoader(systemPrompt: string | undefined, extensions: Extension[], appendix?: string) {
  return {
    getExtensions: () => ({ extensions, errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt ?? FALLBACK_SYSTEM_PROMPT,
    getAppendSystemPrompt: () => (appendix ? [appendix] : []),
    extendResources: () => {},
    reload: async () => {},
  }
}

/** pi 会话文件 TTL：超期即视为陈旧（会话 id→thread 映射只活在 run-manager 内存 map，App 重启后
 * 旧文件不可达；同进程内 7 天未续接的线程续接时会 fail-loud，属可接受边角——SDK 侧 CLI 也有
 * 30 天会话清理的同族衰减）。 */
const SESSION_FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** pi session id 形状（randomUUID 及其变体的宽松面）：跨层来的 id 先过这道，不让脏值进文件名匹配。 */
const SESSION_ID_SHAPE = /^[A-Za-z0-9-]{8,64}$/

/**
 * 陈旧会话文件清扫：JSONL 里是含小说全文的完整对话，不清扫会在 userData 无限积累。TTL 判 mtime
 * （活跃会话每次 append 都会刷新），每进程每目录只扫一次（见 sweptSessionDirs）；尽力而为，
 * 任何失败都不阻断 run。一次性惰性清扫，不常驻定时任务。
 */
export function sweepStalePiSessionFiles(dir: string, ttlMs = SESSION_FILE_TTL_MS, now = Date.now()): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    try {
      const path = join(dir, name)
      if (statSync(path).mtimeMs < now - ttlMs) unlinkSync(path)
    } catch {
      // 单个文件读不到/删不掉就跳过——清扫是卫生工作，不是正确性前提
    }
  }
}

/**
 * 按 pi 原生文件命名约定（`${timestamp}_${sessionId}.jsonl`，session-manager.js newSession）在
 * dir 内定位会话文件。多个命中（理论不可能）取文件名排序最新的一个（时间戳前缀字典序即时序）。
 */
export function findPiSessionFile(dir: string, sessionId: string): string | undefined {
  if (!SESSION_ID_SHAPE.test(sessionId)) return undefined
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  const matches = entries.filter((name) => name.endsWith(`_${sessionId}.jsonl`)).sort()
  const latest = matches[matches.length - 1]
  return latest ? join(dir, latest) : undefined
}

const sweptSessionDirs = new Set<string>()

/** 跨会话进程内单调计数：合成 toolCallId 必须全进程唯一——sink 按 toolCallId 归并是 run 级全局，
 * 并发子会话若各自从 1 计数就把撞号问题原样搬回来。 */
let missingToolCallIdCounter = 0

/**
 * toolCallId 空串兜底（生产接线门前项③）：provider 响应漏 tool call id 时 pi 会退化成空串，
 * 并发子会话间撞号会让 sink 按 toolCallId 归并错位。桥级修补：start 缺号即补发进程内唯一合成号，
 * end 缺号按 FIFO 领取对应 start 的合成号（同会话内工具默认顺序执行，FIFO 即正确配对；并行工具
 * 且集体缺号时为尽力而为——缺号本身已丢失配对信息，兜底目标是「不撞号」而非「完美配对」）。
 */
function createToolCallIdNormalizer(): (event: unknown) => unknown {
  const pendingSyntheticIds: string[] = []
  return (event: unknown): unknown => {
    if (!isRecord(event)) return event
    if (event.type === 'tool_execution_start' && !event.toolCallId) {
      const syntheticId = `narracat-missing-tc-${++missingToolCallIdCounter}`
      pendingSyntheticIds.push(syntheticId)
      return { ...event, toolCallId: syntheticId }
    }
    if (event.type === 'tool_execution_end' && !event.toolCallId) {
      const syntheticId = pendingSyntheticIds.shift() ?? `narracat-missing-tc-${++missingToolCallIdCounter}`
      return { ...event, toolCallId: syntheticId }
    }
    return event
  }
}

/**
 * 会话装配三分支：无 sessionStore → in-memory（子会话路径，切片⑥行为不变）；有 dir 无 resume →
 * 新建持久化会话；有 resumeSessionId → 定位文件 open 续接，找不到 fail-loud——静默降级成新会话
 * 会让「续聊」悄悄丢光上下文，比报错更坏（对齐本 adapter 未支持面一律 fail-loud 的纪律）。
 */
function resolveSessionManager(options: PiRunOptions): SessionManager {
  const store = options.sessionStore
  if (!store) return SessionManager.inMemory(options.cwd)
  mkdirSync(store.dir, { recursive: true })
  if (!sweptSessionDirs.has(store.dir)) {
    sweptSessionDirs.add(store.dir)
    sweepStalePiSessionFiles(store.dir)
  }
  if (store.resumeSessionId) {
    const file = findPiSessionFile(store.dir, store.resumeSessionId)
    if (!file) {
      throw new Error(`找不到要续接的会话记录（id=${store.resumeSessionId}），请开始新对话。`)
    }
    return SessionManager.open(file, store.dir, options.cwd)
  }
  return SessionManager.create(options.cwd, store.dir)
}

export interface RunPiSessionArgs {
  prompt: string | AsyncIterable<unknown>
  options: PiRunOptions
  createSession?: CreatePiSession
}

export async function* runPiSession({
  prompt,
  options,
  createSession = createAgentSession as unknown as CreatePiSession,
}: RunPiSessionArgs): AsyncGenerator<unknown> {
  if (typeof prompt !== 'string') {
    throw new Error('pi adapter 暂不支持流式输入 prompt（阶段 2 切片②事件映射+基础 run 一并接）')
  }

  // 入口 abort 窗口检查：调用方在传入前就已 abort，语义等同于"运行中途 abort 后立即完结"——
  // 不创建会话、不发起 prompt、生成器直接结束，不视为错误（与运行中 abort 的行为对称）。
  if (options.abortController.signal.aborted) return

  mkdirSync(options.agentDir, { recursive: true })
  const authStorage = AuthStorage.inMemory()
  authStorage.setRuntimeApiKey(options.provider, options.apiKey)

  // 会话装配（切片⑦）：resume 定位失败在这里就抛（未发起任何网络调用），fail-loud 早于建会话。
  const sessionManager = resolveSessionManager(options)

  const { session } = await createSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    model: options.model,
    thinkingLevel: 'off',
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    resourceLoader: createIsolatedResourceLoader(options.systemPrompt, options.extensions, options.systemPromptAppendix),
    tools: options.tools,
    customTools: options.customTools,
    sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  })

  // 工具名同步归一（issue #136）：建会话后、首次 prompt 前替换 streamFn，改名赶在工具查找之前。
  // 假会话（单测 DI）没有 agent 字段，跳过即可；真会话的 agent 若不再暴露 streamFn（pi 升级改了
  // 字段），出声告警而不是静默退回只剩 message_end 兜底——wire 测试的对照组会同时变红。
  const agent = (session as { agent?: { streamFn?: unknown } }).agent
  if (agent) {
    if (typeof agent.streamFn === 'function') {
      agent.streamFn = wrapStreamFnWithToolCallNameNormalizer(
        agent.streamFn as (...args: never[]) => unknown,
        () => options.tools,
      )
    } else {
      console.warn('[narracat] pi agent.streamFn 不可替换，工具名同步归一未生效，只剩 message_end 兜底（#136）')
    }
  }

  // await createSession 窗口期检查：signal 可能在建会话期间才被 abort，这段时间没有监听器能捕获到
  // 那次 abort 事件（addEventListener 还没注册）。会话已建但还没订阅/没发起 prompt，直接中止已创建的
  // 会话再结束，避免"窗口期 abort 被静默吞掉、prompt 无法取消地跑到底"。
  if (options.abortController.signal.aborted) {
    await safeAbort(session)
    return
  }

  // 会话 id 首发（切片⑦）：持久化会话建立后、任何 pi 事件之前透出，run-manager 经 readSessionId
  // 记进 sdkSessionsByThread。in-memory 会话刻意不发——发了 run-manager 会记下一个无法 resume 的
  // 死 id，下次续接直接 fail-loud，误导比缺失更坏。
  if (options.sessionStore) {
    const sessionMessage: PiSessionMessage = {
      type: PI_SESSION_MESSAGE_TYPE,
      sessionId: sessionManager.getSessionId(),
    }
    yield sessionMessage
  }

  // 事件桥：subscribe 回调入队，生成器按序透出；prompt settle 后排干队列再完结。
  // notify 在同步段内成对设置/消费，单线程下无丢通知窗口。
  const queue: unknown[] = []
  let notify: (() => void) | undefined

  // run 级状态（映射器无状态，run 级语义全在桥内）：回合计数、usage 聚合、错误/预算终态判定。
  let turnCount = 0
  let budgetTripped = false
  // 同错连犯即停（issue #111 / #112）：与回合预算同为「命中即 abort、排干后补合成终态」。
  const repeatedFailureTracker = createRepeatedToolFailureTracker()
  let repeatedFailure: RepeatedToolFailure | undefined
  let sawErrorStop = false
  let sawUsage = false
  const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

  function accumulate(event: UnknownRecord): void {
    if (event.type === 'tool_execution_end') {
      const tripped = repeatedFailureTracker.observe(event)
      if (tripped && !budgetTripped) {
        repeatedFailure = tripped
        console.warn(`[narracat] pi 会话同一工具连续 ${tripped.count} 次报同样的错，已中止：${tripped.toolName}`)
        void safeAbort(session)
      }
      return
    }
    if (event.type === 'turn_end') {
      turnCount += 1
      // 触顶判定门 = 模型是否还想继续（stopReason==='toolUse'）而非单纯计数。pi 的 agent-loop 最后一个
      // 自然回合也发 turn_end：'stop'/'length' 是模型已收笔，即使计数刚好到顶也是正常完结，不该报
      // 回合上限；只有模型还要下一轮工具调用（'toolUse'）却已经没有预算了，才是真触顶——语义对齐 SDK
      // 的「第 N 回合内完成算 success，要第 N+1 回合才 error_max_turns」。
      const stopReason = isRecord(event.message) ? event.message.stopReason : undefined
      if (!budgetTripped && !repeatedFailure && turnCount >= options.maxTurns && stopReason === 'toolUse') {
        budgetTripped = true
        void safeAbort(session)
      }
      return
    }
    if (event.type === 'message_end' && isRecord(event.message)) {
      const inner = event.message
      // 'length' 与 'error' 同族（映射器已发 run.failed），桥不再补发 run_end 避免自相矛盾终态。
      if (inner.stopReason === 'error' || inner.stopReason === 'aborted' || inner.stopReason === 'length') {
        sawErrorStop = true
      }
      const usage = inner.usage
      if (isRecord(usage)) {
        for (const [from, to] of [
          ['input', 'input'],
          ['output', 'output'],
          ['cacheRead', 'cacheRead'],
          ['cacheWrite', 'cacheWrite'],
        ] as const) {
          if (typeof usage[from] === 'number') {
            usageTotals[to] += usage[from]
            sawUsage = true
          }
        }
      }
    }
  }

  /**
   * 子会话 usage 并账：读子会话每条 message_end 的 pi 原生 usage（与父会话同一口径），**不读**子会话
   * 的合成 narracat_pi_run_end。两条理由：
   * - 不漏账：子会话触 maxTurns / 模型报错 / 被中止时其桥都不发 run_end（见本文件合成终态三分支），
   *   只认 run_end 会让最贵的三条失败路径 token 全丢。
   * - 不重复：run_end.usage 本就是该子会话自身 message_end 的累加，读上游即等价。
   * 子会话的 turn_end 不并进父会话 turnCount——回合预算父子各算各的（子会话自己那份桥已在管）。
   */
  function accumulateSubagent(wrapped: PiSubagentEventMessage): void {
    const inner = wrapped.message
    if (!isRecord(inner) || inner.type !== 'message_end') return
    const message = inner.message
    if (!isRecord(message)) return
    const usage = message.usage
    if (!isRecord(usage)) return
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      if (typeof usage[key] === 'number') {
        usageTotals[key] += usage[key]
        sawUsage = true
      }
    }
  }

  const normalizeToolCallId = createToolCallIdNormalizer()
  const maybeUnsubscribe = session.subscribe((event) => {
    const normalized = normalizeToolCallId(event)
    queue.push(normalized)
    if (isRecord(normalized)) accumulate(normalized)
    notify?.()
  })
  const unsubscribe = typeof maybeUnsubscribe === 'function' ? (maybeUnsubscribe as () => void) : undefined
  const unsubscribeChannel = options.subagentChannel?.subscribe((wrapped) => {
    queue.push(wrapped)
    accumulateSubagent(wrapped)
    notify?.()
  })

  const onAbort = () => {
    void safeAbort(session)
  }
  options.abortController.signal.addEventListener('abort', onAbort, { once: true })

  let settled = false
  let promptError: unknown
  const promptPromise = Promise.resolve(session.prompt(prompt))
    .catch((error: unknown) => {
      promptError = error ?? new Error('pi session prompt 失败（无错误对象）')
    })
    .finally(() => {
      settled = true
      notify?.()
    })

  try {
    while (true) {
      while (queue.length > 0) yield queue.shift()
      if (settled) break
      await new Promise<void>((resolve) => {
        notify = resolve
      })
      notify = undefined
    }
    while (queue.length > 0) yield queue.shift()
    await promptPromise
    if (promptError) throw promptError

    // 合成终态：满足 run-manager「流尽必须见过终态事件」契约。用户取消不发（cancelling 分支收口）；
    // 模型错误终态已由 message_end 映射为 run.failed，不再补发避免自相矛盾。
    if (repeatedFailure) {
      const repeatedMessage: PiRepeatedToolFailureMessage = {
        type: PI_REPEATED_TOOL_FAILURE_MESSAGE_TYPE,
        toolName: repeatedFailure.toolName,
      }
      yield repeatedMessage
    } else if (budgetTripped) {
      const maxTurnsMessage: PiMaxTurnsMessage = { type: PI_MAX_TURNS_MESSAGE_TYPE }
      yield maxTurnsMessage
    } else if (!options.abortController.signal.aborted && !sawErrorStop) {
      const runEndMessage: PiRunEndMessage = { type: PI_RUN_END_MESSAGE_TYPE }
      if (sawUsage) {
        const usage: AgentTokenUsage = {
          inputTokens: usageTotals.input,
          outputTokens: usageTotals.output,
          cacheReadTokens: usageTotals.cacheRead,
          cacheCreationTokens: usageTotals.cacheWrite,
        }
        runEndMessage.usage = usage
      }
      yield runEndMessage
    }
  } finally {
    // 消费者提前 break（for-await 隐式调用生成器 .return()）会直接跳进这里，此时 prompt 可能仍在
    // 后台跑——不清理会白跑真实 LLM 调用并持续计费。settled 为 false 说明 prompt 还没 settle，主动
    // 中止；已经 settle（正常完结/已被 abort 事件中止过）则不重复调用。
    options.abortController.signal.removeEventListener('abort', onAbort)
    unsubscribe?.()
    unsubscribeChannel?.()
    if (!settled) await safeAbort(session)
  }
}
