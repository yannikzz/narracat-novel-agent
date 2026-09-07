import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import type { RuntimeCanUseTool } from '../runtime/types.ts'
import type { AgentQuestionAnswerInput, AgentRunRequest, AgentRunStarted } from '../../agent-runner.ts'
import type { AppConfig, ProviderId } from '../../config.ts'
import { redactErrorMessage } from '../../redact.ts'
import type {
  AgentEvent,
  AgentRunActiveStatus,
  AgentRunTarget,
} from '@shared/types/agent'
import { isRuntimeStatusCommand } from './runtime-status.ts'
import { resolveAgentRuntime } from '../runtime/resolve-runtime.ts'
import type { AgentRuntimeAdapter, RuntimeStartRunArgs } from '../runtime/types.ts'
import { hasNarraCatAgentCoreManifest, resolveNarraCatAgentCorePath } from '../../engine/engine.ts'
import { isNarraCatCommandRequest, type ReadNarraCatCommandFile } from './narracat-command.ts'
import { isRecoverWriteRequest } from './recover-write.ts'
import { isWriteNextRequest } from './write-next.ts'
import { createCanUseTool } from '../permissions/can-use-tool.ts'
import { sessionFingerprint } from './run-options.ts'
import { buildDirectChatRunPlan } from './paths/direct-chat-path.ts'
import { buildEngineContextRunPlan, isEngineContextFreeformRequest } from './paths/engine-context-path.ts'
import { buildResumedCommandRunPlan, isResumableProjectCommandSession } from './paths/resumed-command-path.ts'
import { buildNarraCatCommandRunPlan } from './paths/narracat-command-path.ts'
import { buildRecoverWriteRunPlan } from './paths/recover-write-path.ts'
import { buildWriteNextRunPlan } from './paths/write-next-path.ts'
import { resolveRunPreconditions } from './run-preconditions.ts'
import type {
  AgentManuscriptRevisionSource,
  CreateSessionFingerprintFn,
  RunPlan,
  RunPlanResult,
  SdkThreadSession,
  SdkThreadSessionContext,
  SdkThreadSessionMode,
} from './run-options.ts'
import { resolveAgentSkillOverrides } from '../../engine/resolve-agent-skill-overrides.ts'
import type { ResolvedRunAgentSkills } from '../../engine/resolve-agent-skill-overrides.ts'
import type { ManuscriptRevisionStore } from '../../novel/manuscript-revisions.ts'

export interface AgentRunManagerDeps {
  readConfig: () => Promise<AppConfig>
  getApiKey: (provider: ProviderId) => Promise<string | null>
  /** 测试注入面：固定驱动所有 run 的运行时。缺省走 per-run 解析 resolveAgentRuntime(config)——
   * config.agentRuntime 选双底座（A/B 门），设置切换后新 run 立即生效、无需重启。 */
  runtime?: AgentRuntimeAdapter
  agentCoreManifestExists?: (agentCorePath: string) => boolean
  readNarraCatCommandFile?: ReadNarraCatCommandFile
  /**
   * run 启动时组装作者调整的 Agent 覆盖（散文块覆盖 + 作者写的要求）；
   * 缺省读 author-requests.json + prose-overrides.json。返回 { agents }。
   */
  resolveAgentSkillOverrides?: (args: { agentCorePath: string }) => Promise<ResolvedRunAgentSkills>
  /** 是否启用默认 resolver，由 IPC 层注入以标记「非测试环境」（测试缺省走 no-op resolver） */
  enableAuthorSkillOverrides?: boolean
  /** userData 根目录（默认 resolver 读作者调整存量用），由 IPC 层注入 */
  userDataPath?: string
  sendEvent: (event: AgentEvent) => void | Promise<void>
  appRoot: string
  resourcesPath?: string
  now?: () => string
  createRunId?: () => string
  /**
   * 模型流空闲看门狗阈值（ms）：SDK 迭代器超过该时长没有产出任何消息即判定卡死，
   * 自动 abort 并以 run.failed 收尾（断点保留可重试）。缺省 DEFAULT_RUN_IDLE_TIMEOUT_MS。测试注入小值。
   */
  idleTimeoutMs?: number
  /** 连续静默多久后先发出卡顿提示；只提示，不 abort、不释放锁。 */
  stalledTimeoutMs?: number
  createSessionFingerprint?: CreateSessionFingerprintFn
  onSessionContextEstablished?: (
    threadId: string,
    mode: SdkThreadSessionMode,
    compatibilityFingerprintHash: string,
  ) => Promise<void>
  onSessionInvalidated?: (threadId: string, reason: string) => Promise<void>
  manuscriptRevisionStore?: Pick<ManuscriptRevisionStore, 'begin' | 'complete'>
}

export interface AgentRunManager {
  startRun: (request: AgentRunRequest) => Promise<AgentRunStarted>
  cancelRun: (runId: string) => Promise<{ cancelled: boolean }>
  answerQuestion: (answer: AgentQuestionAnswerInput) => Promise<{ accepted: boolean }>
  forgetThreadSession: (threadId: string) => void
  hasActiveRunForThread: (threadId: string) => boolean
  getRunStatus: (runId: string) => AgentRunActiveStatus | undefined
  hasThreadSession: (threadId: string) => boolean
  invalidateAllThreadSessions: (reason: string) => Promise<void>
  hasActiveRuns: () => boolean
  settleActiveRuns: () => Promise<void>
}

interface ActiveRun {
  abortController: AbortController
  threadId: string
  status: 'accepted' | 'running' | 'cancelling' | 'durability-failed'
  interruptForQuit?: boolean
  settled?: Promise<void>
}

interface PendingQuestion {
  runId: string
  resolve: (answer: AgentQuestionAnswerInput) => void
  reject: (error: Error) => void
  cleanup: () => void
}

function isTerminalEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.interrupted' }> {
  return (
    event.type === 'run.completed' ||
    event.type === 'run.failed' ||
    event.type === 'run.cancelled' ||
    event.type === 'run.interrupted'
  )
}

// run 进行中，Agent 写入项目内 .md 产物后触发增量刷新的防抖窗口。
const TRANSIENT_REFRESH_DEBOUNCE_MS = 500

// 模型流空闲看门狗默认阈值：SDK 迭代器超过该时长不再产出任何消息即判定卡死（模型服务 stall /
// 连接半开），自动 abort 收尾。正常生成会持续流 partial 消息，故"完全静默"才会触发，不误伤长生成。
const DEFAULT_RUN_IDLE_TIMEOUT_MS = 30 * 60_000
const DEFAULT_RUN_STALLED_TIMEOUT_MS = 5 * 60_000

type SdkIteratorStep = { kind: 'value'; value: unknown } | { kind: 'done' } | { kind: 'idle' }

/**
 * 取 SDK 异步迭代器的下一条消息，与空闲超时竞速：idleMs 内迭代器既不产出也不结束 → 返回
 * { kind: 'idle' }，调用方据此判定流卡死。
 *
 * 单次 next() 只调一次（同一 promise 多次 await 安全），反复与新的空闲计时竞速：空闲触发时若
 * isWaitingForUser()（有 pending 用户问题），不算 stall——重置计时继续等同一个 next，避免把正常的
 * 等用户作答（/setup、/revise-premise 等 HITL）误判为模型流卡死。计时器无论谁先到都清掉，不泄漏。
 * 注意：流真卡死时被丢弃的 next() Promise 可能永不 settle，那是有意放弃的孤儿——调用方 abort +
 * iterator.return() 尽力收尾。
 */
async function nextWithIdleTimeout(
  iterator: AsyncIterator<unknown>,
  stalledMs: number,
  idleMs: number,
  isWaitingForUser: () => boolean,
  onStalled: () => void | Promise<void>,
): Promise<SdkIteratorStep> {
  const nextPromise = iterator
    .next()
    .then<SdkIteratorStep>((result) => (result.done ? { kind: 'done' } : { kind: 'value', value: result.value }))
  const hasStalledPhase = stalledMs < idleMs
  let stalled = !hasStalledPhase
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutMs = stalled
      ? hasStalledPhase
        ? idleMs - stalledMs
        : idleMs
      : stalledMs
    const idle = new Promise<SdkIteratorStep>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'idle' }), Math.max(1, timeoutMs))
    })
    try {
      const step = await Promise.race([nextPromise, idle])
      if (step.kind === 'idle' && isWaitingForUser()) {
        stalled = false
        continue
      }
      if (step.kind === 'idle' && hasStalledPhase && !stalled) {
        stalled = true
        await onStalled()
        continue
      }
      return step
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

export function isProjectMarkdownWrite(event: AgentEvent, projectPath: string): boolean {
  if (event.type !== 'tool.started') return false
  if (event.toolName !== 'Write' && event.toolName !== 'Edit' && event.toolName !== 'MultiEdit') return false
  const filePath = typeof event.input?.file_path === 'string' ? event.input.file_path : undefined
  if (!filePath || !filePath.toLowerCase().endsWith('.md')) return false
  return isPathInsideProject(filePath, projectPath)
}

function isPathInsideProject(filePath: string, projectPath: string): boolean {
  const rel = relative(resolve(projectPath), resolve(filePath))
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

export function createAgentRunManager(deps: AgentRunManagerDeps): AgentRunManager {
  const activeRuns = new Map<string, ActiveRun>()
  const sdkSessionsByThread = new Map<string, SdkThreadSession>()
  let sessionEnvironmentGeneration = 0
  const pendingQuestions = new Map<string, PendingQuestion>()
  const now = deps.now ?? (() => new Date().toISOString())
  const createRunId = deps.createRunId ?? randomUUID
  /** per-run runtime 解析（A/B 门）：deps.runtime（测试注入）恒优先；生产按 config.agentRuntime
   * 每 run 取一次，run 全生命周期用同一个 adapter 实例（切换只影响新 run，不动在途 run）。 */
  const resolveRuntime = (config: AppConfig): AgentRuntimeAdapter => deps.runtime ?? resolveAgentRuntime(config)
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_RUN_IDLE_TIMEOUT_MS
  const stalledTimeoutMs = deps.stalledTimeoutMs ?? DEFAULT_RUN_STALLED_TIMEOUT_MS
  const agentCoreManifestExists = deps.agentCoreManifestExists ?? hasNarraCatAgentCoreManifest
  const NO_OP_SKILL_OVERRIDES: ResolvedRunAgentSkills = { agents: undefined }
  const resolveSkillOverrides =
    deps.resolveAgentSkillOverrides ??
    (deps.enableAuthorSkillOverrides
      ? ({ agentCorePath }: { agentCorePath: string }) =>
          resolveAgentSkillOverrides({
            agentCorePath,
            userDataPath: deps.userDataPath,
          })
      : async () => NO_OP_SKILL_OVERRIDES)
  const manuscriptRevisionStore = deps.manuscriptRevisionStore

  function currentAgentCorePath(): string {
    return resolveNarraCatAgentCorePath({ appRoot: deps.appRoot, resourcesPath: deps.resourcesPath })
  }

  async function compatibleSession(
    threadId: string,
    config: AppConfig,
  ): Promise<SdkThreadSession | undefined> {
    const existing = sdkSessionsByThread.get(threadId)
    if (!existing) return undefined
    const current = await sessionFingerprint(config, resolveRuntime(config).id, existing, deps.createSessionFingerprint)
    if (current === existing.compatibilityFingerprint) return existing
    sdkSessionsByThread.delete(threadId)
    await deps.onSessionInvalidated?.(threadId, 'compatibility-changed')
    return undefined
  }

  function redactEvent(event: AgentEvent): AgentEvent {
    if (event.type !== 'run.failed') return event
    return { ...event, error: redactErrorMessage(event.error) }
  }

  async function sendEventSafe(event: AgentEvent): Promise<boolean> {
    try {
      await deps.sendEvent(redactEvent(event))
      return true
    } catch {
      return false
    }
  }

  function isActiveRun(runId: string, abortController: AbortController): boolean {
    return activeRuns.get(runId)?.abortController === abortController
  }

  function canContinueRun(runId: string, abortController: AbortController): boolean {
    const active = activeRuns.get(runId)
    return (
      active?.abortController === abortController &&
      (active.status === 'accepted' || active.status === 'running')
    )
  }

  function clearActiveRun(runId: string, abortController: AbortController): void {
    if (isActiveRun(runId, abortController)) activeRuns.delete(runId)
  }

  function hasActiveRunForThread(threadId: string): boolean {
    for (const activeRun of activeRuns.values()) {
      if (activeRun.threadId === threadId) return true
    }

    return false
  }

  function hasPendingQuestionForRun(runId: string): boolean {
    for (const pending of pendingQuestions.values()) {
      if (pending.runId === runId) return true
    }
    return false
  }

  function rejectPendingQuestionsForRun(runId: string, error: Error): void {
    for (const [requestId, pending] of pendingQuestions.entries()) {
      if (pending.runId !== runId) continue
      pendingQuestions.delete(requestId)
      pending.cleanup()
      pending.reject(error)
    }
  }

  function waitForQuestionAnswer(
    runId: string,
    requestId: string,
    abortController: AbortController,
    signal: AbortSignal,
  ): Promise<AgentQuestionAnswerInput> {
    return new Promise((resolve, reject) => {
      const handleAbort = () => {
        pendingQuestions.delete(requestId)
        cleanup()
        reject(new Error('用户问题已取消。'))
      }
      const cleanup = () => {
        signal.removeEventListener('abort', handleAbort)
        abortController.signal.removeEventListener('abort', handleAbort)
      }

      signal.addEventListener('abort', handleAbort, { once: true })
      abortController.signal.addEventListener('abort', handleAbort, { once: true })
      pendingQuestions.set(requestId, {
        runId,
        resolve,
        reject,
        cleanup,
      })
    })
  }

  function createCanUseToolForRun(runId: string, abortController: AbortController): RuntimeCanUseTool {
    return createCanUseTool({
      runId,
      abortController,
      now,
      sendEventSafe,
      markDurabilityFailed: () => {
        const active = activeRuns.get(runId)
        if (active?.abortController === abortController) active.status = 'durability-failed'
      },
      waitForQuestionAnswer,
    })
  }

  async function sendActiveEvent(
    runId: string,
    abortController: AbortController,
    event: AgentEvent,
  ): Promise<boolean> {
    const sent = await sendEventSafe(event)
    if (!sent) {
      const active = activeRuns.get(runId)
      if (active?.abortController === abortController) active.status = 'durability-failed'
      abortController.abort()
    }
    return sent
  }

  async function publishTerminalAfterSettle(
    runId: string,
    abortController: AbortController,
    event: Extract<AgentEvent, { type: 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.interrupted' }>,
  ): Promise<boolean> {
    if (!isActiveRun(runId, abortController)) return false
    const published = await sendEventSafe(event)
    if (published) {
      clearActiveRun(runId, abortController)
      return true
    }
    const active = activeRuns.get(runId)
    if (active?.abortController === abortController) active.status = 'durability-failed'
    abortController.abort()
    return false
  }

  function cancellationTerminalEvent(
    runId: string,
  ): Extract<AgentEvent, { type: 'run.cancelled' | 'run.interrupted' }> {
    return activeRuns.get(runId)?.interruptForQuit
      ? {
          type: 'run.interrupted',
          runId,
          error: 'App 退出时中断了这项任务。已完成的内容仍然保留。',
          createdAt: now(),
        }
      : { type: 'run.cancelled', runId, createdAt: now() }
  }

  function trackSettledRun(
    runId: string,
    abortController: AbortController,
    settled: Promise<void>,
  ): void {
    const active = activeRuns.get(runId)
    if (active?.abortController === abortController) active.settled = settled
    void settled
  }

  async function finalizeCancelledPreparation(
    runId: string,
    abortController: AbortController,
  ): Promise<void> {
    if (activeRuns.get(runId)?.status !== 'cancelling') return
    await publishTerminalAfterSettle(runId, abortController, cancellationTerminalEvent(runId))
  }

  function isStreamedAssistantContent(event: AgentEvent): boolean {
    return event.type === 'message.delta'
  }

  async function streamRun(
    runId: string,
    threadId: string,
    runtime: AgentRuntimeAdapter,
    args: RuntimeStartRunArgs,
    abortController: AbortController,
    projectUpdate?: {
      projectPath: string
      selectedChapter?: number
      target?: AgentRunTarget
      manuscriptRevisionSource?: AgentManuscriptRevisionSource
    },
    threadSessionContext?: SdkThreadSessionContext,
  ): Promise<void> {
    const sessionGenerationAtStart = sessionEnvironmentGeneration
    let hasStreamedAssistantContent = false
    let runningPublished = false
    let transientRefreshTimer: ReturnType<typeof setTimeout> | null = null
    let terminalEvent: Extract<
      AgentEvent,
      { type: 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.interrupted' }
    > | null = null
    let shouldSendProjectUpdate = false
    let manuscriptRevisionId: string | undefined

    function clearTransientRefresh(): void {
      if (transientRefreshTimer) {
        clearTimeout(transientRefreshTimer)
        transientRefreshTimer = null
      }
    }

    function scheduleTransientRefresh(): void {
      if (!projectUpdate) return
      clearTransientRefresh()
      transientRefreshTimer = setTimeout(() => {
        transientRefreshTimer = null
        if (!canContinueRun(runId, abortController)) return
        void sendActiveEvent(runId, abortController, {
          type: 'novel.project.updated',
          runId,
          projectPath: projectUpdate.projectPath,
          transient: true,
          createdAt: now(),
        })
      }, TRANSIENT_REFRESH_DEBOUNCE_MS)
    }

    async function sendProjectUpdate(): Promise<boolean> {
      if (!projectUpdate) return true

      return sendActiveEvent(runId, abortController, {
        type: 'novel.project.updated',
        runId,
        projectPath: projectUpdate.projectPath,
        selectedChapter: projectUpdate.selectedChapter,
        target: projectUpdate.target,
        createdAt: now(),
      })
    }

    // 终态只在 finally 的真实 settle 之后发布：SDK iterator.return、工具链退出和 Skill 临时副本清理
    // 尚未完成时，run 仍保持 running/cancelling，项目锁不能提前释放。
    let iterator: AsyncIterator<unknown> | undefined
    try {
      if (manuscriptRevisionStore && projectUpdate?.manuscriptRevisionSource && projectUpdate.selectedChapter) {
        manuscriptRevisionId = (
          await manuscriptRevisionStore.begin({
            projectPath: projectUpdate.projectPath,
            chapter: projectUpdate.selectedChapter,
            source: projectUpdate.manuscriptRevisionSource,
            runId,
          })
        ).revisionId
      }
      iterator = runtime.startRun(args)[Symbol.asyncIterator]()
      stream:
      while (true) {
        const step = await nextWithIdleTimeout(
          iterator,
          stalledTimeoutMs,
          idleTimeoutMs,
          () => hasPendingQuestionForRun(runId),
          async () => {
            await sendActiveEvent(runId, abortController, {
              type: 'run.stalled',
              runId,
              createdAt: now(),
            })
          },
        )

        if (activeRuns.get(runId)?.status === 'cancelling') {
          terminalEvent = cancellationTerminalEvent(runId)
          break
        }

        if (step.kind === 'idle') {
          terminalEvent = {
            type: 'run.failed',
            runId,
            error: 'Agent 长时间无响应，可能模型服务卡住，已自动停止。断点已保留，可重试。',
            reason: 'idle-timeout',
            createdAt: now(),
          }
          shouldSendProjectUpdate = Boolean(projectUpdate)
          abortController.abort()
          break
        }

        if (step.kind === 'done') {
          terminalEvent = {
            type: 'run.failed',
            runId,
            error: 'Agent 运行结束但没有返回完成状态。',
            createdAt: now(),
          }
          shouldSendProjectUpdate = Boolean(projectUpdate)
          break
        }

        const message = step.value
        if (!canContinueRun(runId, abortController)) {
          if (activeRuns.get(runId)?.status === 'cancelling') {
            terminalEvent = cancellationTerminalEvent(runId)
          }
          break
        }
        if (!runningPublished) {
          if (
            !(await sendActiveEvent(runId, abortController, {
              type: 'run.running',
              runId,
              createdAt: now(),
            }))
          ) {
            return
          }
          runningPublished = true
          const active = activeRuns.get(runId)
          if (active?.abortController === abortController) active.status = 'running'
        }

        const sdkSessionId = runtime.readSessionId(message)
        if (sdkSessionId && sessionGenerationAtStart === sessionEnvironmentGeneration) {
          const nextSession: SdkThreadSession = {
            ...(threadSessionContext ?? { mode: 'direct', loadNarraCatRuntime: false }),
            sessionId: sdkSessionId,
            compatibilityFingerprint:
              threadSessionContext?.compatibilityFingerprint ??
              createHash('sha256').update('legacy-direct-session').digest('hex'),
          }
          const existingSession = sdkSessionsByThread.get(threadId)
          if (
            existingSession?.sessionId !== nextSession.sessionId ||
            existingSession.compatibilityFingerprint !== nextSession.compatibilityFingerprint
          ) {
            try {
              await deps.onSessionContextEstablished?.(
                threadId,
                nextSession.mode,
                nextSession.compatibilityFingerprint,
              )
            } catch {
              const active = activeRuns.get(runId)
              if (active?.abortController === abortController) active.status = 'durability-failed'
              abortController.abort()
              return
            }
          }
          sdkSessionsByThread.set(threadId, nextSession)
        }

        const events = runtime.mapMessage(
          message,
          {
            runId,
            messageId: `assistant-${runId}`,
            createdAt: now(),
            skipAssistantMessageContent: hasStreamedAssistantContent,
          },
        )

        for (const event of events) {
          if (!canContinueRun(runId, abortController)) {
            if (activeRuns.get(runId)?.status === 'cancelling') {
              terminalEvent = cancellationTerminalEvent(runId)
            }
            break stream
          }

          if (isStreamedAssistantContent(event)) hasStreamedAssistantContent = true
          if (projectUpdate && isProjectMarkdownWrite(event, projectUpdate.projectPath)) {
            scheduleTransientRefresh()
          }

          if (isTerminalEvent(event)) {
            clearTransientRefresh()
            terminalEvent = event
            shouldSendProjectUpdate =
              Boolean(projectUpdate) && (event.type === 'run.completed' || event.type === 'run.failed')
            break stream
          }
          if (!(await sendActiveEvent(runId, abortController, event))) return
        }
      }
    } catch (error) {
      if (!isActiveRun(runId, abortController)) return
      if (activeRuns.get(runId)?.status === 'cancelling') {
        terminalEvent = cancellationTerminalEvent(runId)
      } else if (activeRuns.get(runId)?.status !== 'durability-failed') {
        terminalEvent = {
          type: 'run.failed',
          runId,
          error: `Agent 运行失败：${redactErrorMessage(error)}`,
          createdAt: now(),
        }
        shouldSendProjectUpdate = Boolean(projectUpdate)
      }
    } finally {
      clearTransientRefresh()
      rejectPendingQuestionsForRun(runId, new Error('Agent 运行已结束。'))
      await iterator?.return?.(undefined).catch(() => undefined)
      if (manuscriptRevisionStore && manuscriptRevisionId && projectUpdate) {
        try {
          await manuscriptRevisionStore.complete({
            projectPath: projectUpdate.projectPath,
            revisionId: manuscriptRevisionId,
          })
        } catch (error) {
          // begin 已耐久保存 pending capture；下次读取历史会 reconcile，不把已完成 Agent
          // 写入伪装成失败或提前释放 project lock。
          console.error('[manuscript-revisions] Agent 正文版本索引待后续恢复', error)
        }
      }
      if (!terminalEvent && activeRuns.get(runId)?.status === 'cancelling') {
        terminalEvent = cancellationTerminalEvent(runId)
      }
      if (!terminalEvent || activeRuns.get(runId)?.status === 'durability-failed') return
      if (shouldSendProjectUpdate && !(await sendProjectUpdate())) return
      await publishTerminalAfterSettle(runId, abortController, terminalEvent)
    }
  }

  return {
    async startRun(request) {
      if (hasActiveRunForThread(request.threadId)) {
        throw new Error('当前 Agent 线程已有任务运行中，请等待完成后再试。')
      }

      const runId = createRunId()
      const abortController = new AbortController()
      activeRuns.set(runId, { abortController, threadId: request.threadId, status: 'accepted' })

      const startedEventSent = await sendEventSafe({
        type: 'run.started',
        runId,
        threadId: request.threadId,
        command: request.command,
        prompt: request.prompt,
        displayPrompt: request.displayPrompt,
        origin: request.origin,
        projectPath: request.projectPath,
        selectedChapter: request.selectedChapter,
        target: request.target,
        createdAt: now(),
      })
      if (!startedEventSent) {
        activeRuns.delete(runId)
        throw new Error('Agent 历史无法安全保存，任务未启动。')
      }

      try {
        const preconditions = await resolveRunPreconditions({
          runId,
          abortController,
          readConfig: deps.readConfig,
          getApiKey: deps.getApiKey,
          canContinueRun,
          finalizeCancelledPreparation,
          publishTerminalAfterSettle,
          now,
        })
        if (!preconditions.ok) return { runId }
        const { config, apiKey } = preconditions
        const runtime = resolveRuntime(config)

        const needsWriteNext = isWriteNextRequest(request)
        const needsRecoverWrite = isRecoverWriteRequest(request)
        const needsNarraCatCommand = isNarraCatCommandRequest(request)
        const needsNarraCatRuntime =
          needsWriteNext || needsRecoverWrite || needsNarraCatCommand || isRuntimeStatusCommand(request)

        // 作者调整覆盖（散文块覆盖 + 作者写的要求）；失败降级为 undefined。两者都是作者对 Agent
        // 本身的全局调整（存量落在 userData 根），与「本次 run 是否带项目/是否 resume」无关，
        // 故不再按 projectPath/loadNarraCatRuntime 门控——每个 run 统一尝试组装。
        const resumeSessionForSkills = await compatibleSession(request.threadId, config)
        const { agents: agentSkillOverrides } = await resolveSkillOverrides({
          agentCorePath: currentAgentCorePath(),
        })
        if (!canContinueRun(runId, abortController)) {
          await finalizeCancelledPreparation(runId, abortController)
          return { runId }
        }

        let preparationFailure: string | undefined

        // 六条路径模块共用的入参基座 + 调度收尾：拿到路径模块产出的 RunPlan 后统一做
        // canContinueRun 复检 → 调 streamRun；RunPlanResult 版本另外处理路径模块自身的前置失败
        // （preparationFailure）。
        const pathBase = {
          runtime,
          config,
          apiKey,
          abortController,
          appRoot: deps.appRoot,
          resourcesPath: deps.resourcesPath,
          userDataPath: deps.userDataPath,
          agentSkillOverrides,
          canUseTool: createCanUseToolForRun(runId, abortController),
        }
        function dispatchPlan(plan: RunPlan): AgentRunStarted {
          if (canContinueRun(runId, abortController)) {
            trackSettledRun(
              runId,
              abortController,
              streamRun(
                runId,
                request.threadId,
                runtime,
                { prompt: plan.prompt, options: plan.options },
                abortController,
                plan.projectUpdate,
                plan.sessionContext,
              ),
            )
          }
          return { runId }
        }
        function dispatchPlanResult(result: RunPlanResult): AgentRunStarted {
          if (!result.ok) {
            preparationFailure = result.preparationFailure
            return { runId }
          }
          return dispatchPlan(result.plan)
        }

        try {
        if (needsNarraCatRuntime) {
          const agentCorePath = currentAgentCorePath()
          if (!agentCoreManifestExists(agentCorePath)) {
            preparationFailure =
              `未找到 NarraCat Agent Core 运行适配器清单文件。路径：${agentCorePath}。请运行 bun --no-cache run prepare:narracat-agent-core 准备 agent-core/narracat。`
            return { runId }
          }
        }

        // fresh 命令（write/recover/其它 project-command）开启一段全新会话：先清掉本 thread 的旧
        // SDK 会话，确保命令默认跑干净；即使命令在首个 session_id 前失败、未登记新 session，也不残留
        // 旧会话让后续 freeform resume 到更早的脏上下文（review P1 加固）。
        if (needsWriteNext || needsRecoverWrite || needsNarraCatCommand) {
          if (sdkSessionsByThread.delete(request.threadId)) {
            await deps.onSessionInvalidated?.(request.threadId, 'fresh-project-command')
          }
        }

        if (needsWriteNext) {
          return dispatchPlanResult(
            await buildWriteNextRunPlan({
              ...pathBase,
              request,
              agentCorePath: currentAgentCorePath(),
              readNarraCatCommandFile: deps.readNarraCatCommandFile,
              createSessionFingerprint: deps.createSessionFingerprint,
            }),
          )
        }

        if (needsRecoverWrite) {
          return dispatchPlanResult(
            await buildRecoverWriteRunPlan({
              ...pathBase,
              request,
              agentCorePath: currentAgentCorePath(),
              readNarraCatCommandFile: deps.readNarraCatCommandFile,
              createSessionFingerprint: deps.createSessionFingerprint,
            }),
          )
        }

        if (needsNarraCatCommand) {
          return dispatchPlanResult(
            await buildNarraCatCommandRunPlan({
              ...pathBase,
              request,
              agentCorePath: currentAgentCorePath(),
              readNarraCatCommandFile: deps.readNarraCatCommandFile,
              createSessionFingerprint: deps.createSessionFingerprint,
            }),
          )
        }

        const sdkSession = resumeSessionForSkills
        if (isResumableProjectCommandSession(request, sdkSession)) {
          return dispatchPlan(await buildResumedCommandRunPlan({ ...pathBase, request, sdkSession }))
        }

        if (isEngineContextFreeformRequest(request)) {
          return dispatchPlanResult(
            await buildEngineContextRunPlan({
              ...pathBase,
              request,
              agentCorePath: currentAgentCorePath(),
              agentCoreManifestExists,
              createSessionFingerprint: deps.createSessionFingerprint,
            }),
          )
        }

        return dispatchPlan(
          await buildDirectChatRunPlan({
            ...pathBase,
            request,
            needsNarraCatRuntime,
            sdkSession,
            createSessionFingerprint: deps.createSessionFingerprint,
          }),
        )
        } finally {
          if (preparationFailure) {
            await publishTerminalAfterSettle(runId, abortController, {
              type: 'run.failed',
              runId,
              error: preparationFailure,
              createdAt: now(),
            })
          }
        }
      } catch (error) {
        if (isActiveRun(runId, abortController)) {
          await publishTerminalAfterSettle(runId, abortController, {
            type: 'run.failed',
            runId,
            error: `Agent 运行准备失败：${redactErrorMessage(error)}`,
            createdAt: now(),
          })
        }
        return { runId }
      }
    },

    async cancelRun(runId) {
      const activeRun = activeRuns.get(runId)
      if (!activeRun) return { cancelled: false }
      if (activeRun.status === 'durability-failed') return { cancelled: false }
      if (activeRun.status === 'cancelling') return { cancelled: true }

      activeRun.status = 'cancelling'
      const published = await sendEventSafe({
        type: 'run.cancelling',
        runId,
        createdAt: now(),
      })

      if (!published) {
        activeRun.status = 'durability-failed'
        rejectPendingQuestionsForRun(runId, new Error('Agent 历史无法安全保存，任务已停止。'))
        activeRun.abortController.abort()
        throw new Error('Agent 历史无法安全保存，任务保持锁定。')
      }
      rejectPendingQuestionsForRun(runId, new Error('Agent 运行已取消。'))
      activeRun.abortController.abort()
      return { cancelled: true }
    },

    async answerQuestion(answer) {
      const pending = pendingQuestions.get(answer.requestId)
      if (!pending) {
        // 用户点了「提交选择」但主进程已经不在等这道题：留一行日志，事后能分清是问题过期、
        // run 已结束，还是渲染端拿着一个主进程从没登记过的 requestId。
        console.warn(`[narracat] 回答的问题不在等待中：requestId=${answer.requestId} pending=${pendingQuestions.size}`)
        return { accepted: false }
      }

      const published = await sendEventSafe({
        type: 'question.answered',
        runId: pending.runId,
        questionRequestId: answer.requestId,
        answers: answer.answers,
        createdAt: now(),
      })
      if (!published) {
        const activeRun = activeRuns.get(pending.runId)
        if (activeRun) activeRun.status = 'durability-failed'
        activeRun?.abortController.abort()
        pendingQuestions.delete(answer.requestId)
        pending.cleanup()
        pending.reject(new Error('Agent 历史无法安全保存，任务已停止。'))
        throw new Error('Agent 历史无法安全保存，任务已停止。')
      }
      pendingQuestions.delete(answer.requestId)
      pending.cleanup()
      pending.resolve(answer)
      return { accepted: true }
    },

    forgetThreadSession(threadId) {
      sdkSessionsByThread.delete(threadId)
    },

    hasActiveRunForThread,

    getRunStatus(runId) {
      const active = activeRuns.get(runId)
      if (!active) return undefined
      if (hasPendingQuestionForRun(runId)) return 'waiting-user'
      return active.status
    },

    hasThreadSession(threadId) {
      return sdkSessionsByThread.has(threadId)
    },

    async invalidateAllThreadSessions(reason) {
      sessionEnvironmentGeneration += 1
      const threadIds = [...sdkSessionsByThread.keys()]
      sdkSessionsByThread.clear()
      await Promise.all(threadIds.map((threadId) => deps.onSessionInvalidated?.(threadId, reason)))
    },

    hasActiveRuns() {
      return activeRuns.size > 0
    },

    async settleActiveRuns() {
      const settling: Promise<void>[] = []
      for (const [runId, activeRun] of activeRuns) {
        if (activeRun.status === 'durability-failed') continue
        activeRun.interruptForQuit = true
        if (activeRun.status === 'accepted' || activeRun.status === 'running') {
          activeRun.status = 'cancelling'
          rejectPendingQuestionsForRun(runId, new Error('App 正在退出，Agent 运行已中断。'))
          await sendEventSafe({ type: 'run.cancelling', runId, createdAt: now() })
          activeRun.abortController.abort()
        }
        if (activeRun.settled) settling.push(activeRun.settled)
      }
      await Promise.allSettled(settling)
    },
  }
}
