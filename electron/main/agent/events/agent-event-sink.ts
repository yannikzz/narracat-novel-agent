import type {
  AgentEvent,
  AgentEventEnvelopeV1,
  AgentEventsAfterResultV1,
  AgentHistorySegmentSummaryV1,
  AgentThreadSnapshotV1,
} from '@shared/types/agent'
import type {
  AgentDurableEventV1,
  AgentMessagePart,
  AgentTaskPlanItem,
  AgentRunTarget,
} from '@shared/types/agent'
import type { AgentConversationStore } from './agent-conversation-store.ts'
import {
  sanitizeDurableAnswers,
  sanitizeDurablePlanItems,
  sanitizeDurableQuestions,
  sanitizeDurableSummary,
  sanitizeDurableText,
} from '@shared/lib/agent-durable-events'
import {
  extractToolTargetPath,
  relativizeKnownRoots,
  type ScrubRoot,
} from '@shared/lib/agent-path-scrub'
import { applyTaskToolCall } from './task-plan-from-tools.ts'
import { resolveRunVisiblePrompt } from '@shared/lib/run-visible-prompt.ts'

interface SegmentLiveState {
  segmentId: string
  nextSeq: number
  ring: AgentEventEnvelopeV1[]
}

interface LiveRunProjection {
  threadId: string
  assistantText: string
  taskPlan: AgentTaskPlanItem[]
  tools: Map<string, { messageId: string; toolName: string; title: string; target?: string }>
  status: 'accepted' | 'running' | 'waiting-user' | 'cancelling' | 'durability-failed'
  lastEventAt: string
  stalledAt?: string
  projectPath?: string
  selectedChapter?: number
  target?: AgentRunTarget
}

export interface AgentEventSink {
  publish: (event: AgentEvent) => Promise<void>
  getThreadSnapshot: (threadId: string, segmentId?: string) => Promise<AgentThreadSnapshotV1>
  listHistorySegments: (threadId: string) => Promise<AgentHistorySegmentSummaryV1[]>
  getEventsAfter: (threadId: string, segmentId: string, afterSeq: number) => Promise<AgentEventsAfterResultV1>
  startNewConversation: (
    threadId: string,
    requestId: string,
    occurredAt?: string,
  ) => Promise<AgentThreadSnapshotV1>
  reconcileInterruptedRuns: () => Promise<number>
  establishSessionContext: (
    threadId: string,
    mode: 'direct' | 'project-command',
    compatibilityFingerprintHash: string,
    occurredAt?: string,
  ) => Promise<void>
  invalidateSessionContext: (threadId: string, reason: string, occurredAt?: string) => Promise<void>
}

export interface AgentEventSinkOptions {
  store: AgentConversationStore
  broadcast: (event: AgentEventEnvelopeV1) => void
  /** durable commit 与 renderer 广播之间执行的主进程副作用；失败不回滚历史。 */
  beforeBroadcast?: (event: AgentEventEnvelopeV1) => void | Promise<void>
  onSideEffectError?: (error: unknown, event: AgentEventEnvelopeV1) => void
  now?: () => string
  ringSize?: number
  /**
   * Agent Core 根路径。用于把引擎侧的读写路径相对化成 `<引擎>/…`（#37 取证）——
   * 开发机上引擎目录同样在用户目录下，不给根就会被脱敏整段抹掉。
   */
  agentCorePath?: string
}

function runIdForPayload(payload: AgentDurableEventV1 | AgentEvent): string | undefined {
  return 'runId' in payload ? payload.runId : undefined
}

function overlayLiveAssistant(
  snapshot: AgentThreadSnapshotV1,
  runId: string,
  liveRun: LiveRunProjection,
): AgentThreadSnapshotV1['history'] {
  const messageId = `assistant-${runId}`
  return snapshot.history.map((message) => {
    if (message.id !== messageId || message.role !== 'assistant') return message
    const parts: AgentMessagePart[] = message.parts.filter((part) => part.type !== 'text')
    for (const [toolCallId, tool] of liveRun.tools) {
      if (
        parts.some(
          (part) => part.type === 'tool-call' && part.toolCallId === toolCallId,
        )
      ) {
        continue
      }
      parts.push({
        id: `part-${toolCallId}`,
        type: 'tool-call',
        toolCallId,
        toolName: tool.toolName,
        title: tool.title,
        status: 'running',
      })
    }
    if (liveRun.assistantText) {
      parts.push({
        id: `part-assistant-${runId}-live-text`,
        type: 'text',
        text: liveRun.assistantText,
        status: 'running',
      })
    }
    return { ...message, status: 'running', parts }
  })
}

export function createAgentEventSink(options: AgentEventSinkOptions): AgentEventSink {
  const ringSize = options.ringSize ?? 512
  const now = options.now ?? (() => new Date().toISOString())
  const states = new Map<string, SegmentLiveState>()
  const runs = new Map<string, LiveRunProjection>()
  const runThreads = new Map<string, string>()
  const queues = new Map<string, Promise<unknown>>()
  const recentNewConversationRequests = new Map<string, AgentThreadSnapshotV1>()
  const projectRevisions = new Map<string, number>()

  function enqueue<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(threadId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    queues.set(threadId, current)
    return current.finally(() => {
      if (queues.get(threadId) === current) queues.delete(threadId)
    })
  }

  async function stateFor(threadId: string): Promise<SegmentLiveState> {
    const existing = states.get(threadId)
    if (existing) return existing
    const segment = await options.store.ensureActiveSegment(threadId)
    const state: SegmentLiveState = {
      segmentId: segment.manifest.segmentId,
      nextSeq: segment.projection.lastSeq + 1,
      ring: [],
    }
    states.set(threadId, state)
    return state
  }

  function remember(state: SegmentLiveState, envelope: AgentEventEnvelopeV1): void {
    state.ring.push(envelope)
    if (state.ring.length > ringSize) state.ring.splice(0, state.ring.length - ringSize)
  }

  async function publishPayload(
    threadId: string,
    payload: AgentDurableEventV1 | AgentEvent,
    durability: 'durable' | 'transient',
  ): Promise<AgentEventEnvelopeV1> {
    const state = await stateFor(threadId)
    const seq = state.nextSeq
    state.nextSeq += 1
    const envelope: AgentEventEnvelopeV1 = {
      schemaVersion: 1,
      eventId: `${state.segmentId}:${seq}`,
      threadId,
      segmentId: state.segmentId,
      ...(runIdForPayload(payload) ? { runId: runIdForPayload(payload) } : {}),
      seq,
      durability,
      occurredAt: payload.createdAt,
      payload,
    }
    try {
      if (durability === 'durable') await options.store.appendDurableEvent(envelope)
    } catch (error) {
      state.nextSeq = seq
      throw error
    }
    remember(state, envelope)
    try {
      await options.beforeBroadcast?.(envelope)
    } catch (error) {
      options.onSideEffectError?.(error, envelope)
    }
    try {
      options.broadcast(envelope)
    } catch {
      // renderer/window 投递是 fail-soft；durable commit 已完成，绝不能反向结束 run。
    }
    return envelope
  }

  /**
   * 取证时允许保留相对路径的已知根（#37）。根以上的部分（用户名、本机目录结构）不落盘，
   * 根以下的部分保留——既不泄露隐私，又能看出 agent 读的是哪一类文件。
   */
  function scrubRootsFor(run: LiveRunProjection): ScrubRoot[] {
    const roots: ScrubRoot[] = []
    if (run.projectPath) roots.push({ label: '项目', path: run.projectPath })
    if (options.agentCorePath) roots.push({ label: '引擎', path: options.agentCorePath })
    return roots
  }

  function durableToolEvent(
    event: Extract<AgentEvent, { type: 'tool.completed' | 'tool.failed' }>,
    run: LiveRunProjection,
  ): AgentDurableEventV1 | null {
    const tool = run.tools.get(event.toolCallId)
    if (!tool) return null
    const target = tool.target === undefined ? {} : { target: tool.target }
    // 错误串里的路径先相对化再脱敏：否则 `access '/Users/…'` 会被整段抹成 `[本机路径]`，
    // 连我们也查不出 agent 读的是哪个文件（#37）。
    const roots = scrubRootsFor(run)
    if (event.type === 'tool.completed') {
      return {
        type: 'run.tool-summarized',
        runId: event.runId,
        messageId: tool.messageId,
        toolCallId: event.toolCallId,
        toolName: tool.toolName,
        title: sanitizeDurableText(tool.title, '工具执行完成', 500),
        status: 'complete',
        summary: sanitizeDurableSummary(relativizeKnownRoots(event.summary ?? '', roots), '工具执行完成'),
        ...target,
        createdAt: event.createdAt,
      }
    }
    return {
      type: 'run.tool-summarized',
      runId: event.runId,
      messageId: tool.messageId,
      toolCallId: event.toolCallId,
      toolName: tool.toolName,
      title: sanitizeDurableText(tool.title, '工具执行失败', 500),
      status: 'failed',
      error: sanitizeDurableSummary(relativizeKnownRoots(event.error, roots), '工具执行失败'),
      ...target,
      createdAt: event.createdAt,
    }
  }

  async function publishTerminal(
    event: Extract<AgentEvent, { type: 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.interrupted' }>,
  ) {
    const run = runs.get(event.runId)
    if (!run) throw new Error('Agent durable sink 缺少 run 上下文。')
    if (run.taskPlan.length > 0) {
      await publishPayload(
        run.threadId,
        {
          type: 'run.plan-finalized',
          runId: event.runId,
          items: sanitizeDurablePlanItems(run.taskPlan),
          createdAt: event.createdAt,
        },
        'durable',
      )
    }
    const assistantText = sanitizeDurableText(run.assistantText)
    const payload: AgentDurableEventV1 =
      event.type === 'run.completed'
        ? {
            type: 'run.completed',
            runId: event.runId,
            assistantText,
            usage: event.usage,
            createdAt: event.createdAt,
          }
        : event.type === 'run.failed'
          ? {
              type: 'run.failed',
              runId: event.runId,
              assistantText,
              error: sanitizeDurableSummary(event.error, 'Agent 运行失败。'),
              reason: event.reason,
              provider: event.provider,
              createdAt: event.createdAt,
            }
          : event.type === 'run.interrupted'
            ? {
                type: 'run.interrupted',
                runId: event.runId,
                assistantText,
                error: sanitizeDurableSummary(event.error, 'Agent 任务已中断。'),
                createdAt: event.createdAt,
              }
            : {
                type: 'run.cancelled',
                runId: event.runId,
                assistantText,
                createdAt: event.createdAt,
              }
    await publishPayload(run.threadId, payload, 'durable')
    runs.delete(event.runId)
  }

  return {
    async publish(event) {
      if (event.type === 'run.started') {
        if ([...runs.values()].some((run) => run.threadId === event.threadId)) {
          throw new Error('当前 Agent 线程已有任务运行中，请等待完成后再试。')
        }
        runs.set(event.runId, {
          threadId: event.threadId,
          assistantText: '',
          taskPlan: [],
          tools: new Map(),
          status: 'accepted',
          lastEventAt: event.createdAt,
          projectPath: event.projectPath,
          selectedChapter: event.selectedChapter,
          target: event.target,
        })
        runThreads.set(event.runId, event.threadId)
        if (runThreads.size > 512) runThreads.delete(runThreads.keys().next().value!)
        try {
          await enqueue(event.threadId, async () => {
            await publishPayload(
              event.threadId,
              {
                type: 'run.accepted',
                runId: event.runId,
                command: event.command,
                visiblePrompt: sanitizeDurableText(resolveRunVisiblePrompt(event)),
                origin: event.origin,
                selectedChapter: event.selectedChapter,
                target: event.target,
                createdAt: event.createdAt,
              },
              'durable',
            )
            // 绝对路径、完整执行 prompt 等只进入当前进程 live projection，不写入磁盘。
            await publishPayload(event.threadId, event, 'transient')
          })
        } catch (error) {
          runs.delete(event.runId)
          runThreads.delete(event.runId)
          throw error
        }
        return
      }

      const run = runs.get(event.runId)
      if (!run) {
        const completedThreadId = runThreads.get(event.runId)
        if (event.type === 'novel.project.updated' && completedThreadId) {
          projectRevisions.set(completedThreadId, (projectRevisions.get(completedThreadId) ?? 0) + 1)
          await enqueue(completedThreadId, () => publishPayload(completedThreadId, event, 'transient'))
          return
        }
        // P1A-2 仍保留 per-WebContents manager；没有 accepted 上下文的事件不可安全归属，直接拒绝。
        throw new Error('Agent durable sink 无法识别事件所属会话。')
      }
      await enqueue(run.threadId, async () => {
        run.lastEventAt = event.createdAt
        if (event.type === 'novel.project.updated') {
          projectRevisions.set(run.threadId, (projectRevisions.get(run.threadId) ?? 0) + 1)
        }
        if (event.type === 'message.delta') {
          run.assistantText += event.text
          await publishPayload(run.threadId, event, 'transient')
          return
        }
        if (event.type === 'tool.started') {
          // 段落边界（A/B dogfood 修复）：工具/问答边界之前的文本是过程叙述（「让我检查…」、
          // 访谈问题铺垫等），只在 transient 流里实时可见，不进最终转录——run 收尾持久化的
          // assistantText 只保留最后一段（工具/问答全部结束后的总结），否则问答完成或用户手动
          // 终止时全程过程文本会平铺成一个巨型气泡。子会话事件带 parentToolCallId 不算主会话边界。
          if (!event.parentToolCallId) run.assistantText = ''
          // 目标路径只在 tool.started 的 input 里，收尾事件（tool.completed/failed）拿不到，
          // 所以在这里就取出并相对化存起来，供落盘取证使用（#37）。
          const rawTarget = extractToolTargetPath(event.input)
          const target =
            rawTarget === undefined
              ? undefined
              : sanitizeDurableText(relativizeKnownRoots(rawTarget, scrubRootsFor(run)), '', 500)
          run.tools.set(event.toolCallId, {
            ...(target ? { target } : {}),
            messageId: event.messageId,
            toolName: event.toolName,
            title: event.title,
          })
          await publishPayload(run.threadId, event, 'transient')
          const planItems = applyTaskToolCall(run.taskPlan, event.toolName, event.input)
          if (planItems) {
            run.taskPlan = planItems
            await publishPayload(
              run.threadId,
              { type: 'task-plan.updated', runId: event.runId, items: planItems, createdAt: event.createdAt },
              'transient',
            )
          }
          return
        }
        if (event.type === 'tool.completed' || event.type === 'tool.failed') {
          const durable = durableToolEvent(event, run)
          if (durable) {
            await publishPayload(run.threadId, durable, 'durable')
          } else {
            await publishPayload(run.threadId, event, 'transient')
          }
          return
        }
        if (event.type === 'question.requested') {
          // 同 tool.started 的段落边界语义：问题卡自带问题原文，铺垫文本不进最终转录
          run.assistantText = ''
          run.status = 'waiting-user'
          await publishPayload(
            run.threadId,
            {
              type: 'run.question-requested',
              runId: event.runId,
              messageId: event.messageId,
              questionRequestId: event.questionRequestId,
              toolCallId: event.toolCallId,
              questions: sanitizeDurableQuestions(event.questions),
              createdAt: event.createdAt,
            },
            'durable',
          )
          return
        }
        if (event.type === 'question.answered') {
          run.status = 'running'
          await publishPayload(
            run.threadId,
            {
              type: 'run.question-answered',
              runId: event.runId,
              questionRequestId: event.questionRequestId,
              answers: sanitizeDurableAnswers(event.answers),
              createdAt: event.createdAt,
            },
            'durable',
          )
          return
        }
        if (event.type === 'task-plan.updated') {
          run.taskPlan = event.items
          await publishPayload(run.threadId, event, 'transient')
          return
        }
        if (event.type === 'run.running') run.status = 'running'
        if (event.type === 'run.cancelling') run.status = 'cancelling'
        if (event.type === 'run.stalled') run.stalledAt = event.createdAt
        if (event.type === 'run.durability-failed') run.status = 'durability-failed'
        if (
          event.type === 'run.completed' ||
          event.type === 'run.failed' ||
          event.type === 'run.cancelled' ||
          event.type === 'run.interrupted'
        ) {
          await publishTerminal(event)
          return
        }
        await publishPayload(run.threadId, event, 'transient')
      })
    },

    getThreadSnapshot(threadId, segmentId) {
      return enqueue(threadId, async () => {
        let snapshot = await options.store.getThreadSnapshot(threadId, segmentId)
        if (!segmentId && snapshot.activeRun && !runs.has(snapshot.activeRun.id)) {
          await publishPayload(
            threadId,
            {
              type: 'run.interrupted',
              runId: snapshot.activeRun.id,
              assistantText: '',
              error: '上次关闭 App 时，这项任务还没有完成。已完成的内容仍然保留。',
              createdAt: now(),
            },
            'durable',
          )
          snapshot = await options.store.getThreadSnapshot(threadId)
        }
        const liveRun = snapshot.activeRun ? runs.get(snapshot.activeRun.id) : undefined
        if (snapshot.activeRun && liveRun) {
          snapshot = {
            ...snapshot,
            history: overlayLiveAssistant(snapshot, snapshot.activeRun.id, liveRun),
            activeRun: {
              ...snapshot.activeRun,
              status: liveRun.status,
              lastEventAt: liveRun.lastEventAt,
              stalledAt: liveRun.stalledAt,
              projectPath: liveRun.projectPath,
              selectedChapter: liveRun.selectedChapter,
              target: liveRun.target,
              ...(liveRun.taskPlan.length > 0
                ? {
                    taskPlan: {
                      runId: snapshot.activeRun.id,
                      items: liveRun.taskPlan,
                      updatedAt: liveRun.lastEventAt,
                    },
                  }
                : {}),
            },
          }
        }
        return { ...snapshot, projectRevision: projectRevisions.get(threadId) ?? 0 }
      })
    },

    listHistorySegments(threadId) {
      return enqueue(threadId, () => options.store.listHistorySegments(threadId))
    },

    async getEventsAfter(threadId, segmentId, afterSeq) {
      const state = states.get(threadId)
      if (!state || state.segmentId !== segmentId) return { status: 'snapshot-required' }
      const events = state.ring.filter((event) => event.seq > afterSeq)
      if (events.length === 0) return { status: 'ok', events: [] }
      if (events[0]!.seq !== afterSeq + 1) return { status: 'snapshot-required' }
      return { status: 'ok', events }
    },

    startNewConversation(threadId, requestId, occurredAt = now()) {
      return enqueue(threadId, async () => {
        if ([...runs.values()].some((run) => run.threadId === threadId)) {
          throw new Error('当前 Agent 仍在运行，无法开始新对话。')
        }
        const requestKey = `${threadId}:${requestId}`
        const previous = recentNewConversationRequests.get(requestKey)
        if (previous) return previous
        const snapshot = await options.store.startNewConversation(threadId, occurredAt)
        const state: SegmentLiveState = {
          segmentId: snapshot.segmentId,
          nextSeq: snapshot.lastSeq + 1,
          ring: [],
        }
        states.set(threadId, state)
        const divider = snapshot.history.at(-1)
        if (divider?.role === 'divider') {
          const envelope: AgentEventEnvelopeV1 = {
            schemaVersion: 1,
            eventId: `${snapshot.segmentId}:${snapshot.lastSeq}`,
            threadId,
            segmentId: snapshot.segmentId,
            seq: snapshot.lastSeq,
            durability: 'durable',
            occurredAt,
            payload: {
              type: 'conversation.divider-added',
              dividerId: divider.id,
              createdAt: divider.createdAt,
            },
          }
          remember(state, envelope)
          try {
            options.broadcast(envelope)
          } catch {
            // fail-soft
          }
        }
        recentNewConversationRequests.set(requestKey, snapshot)
        if (recentNewConversationRequests.size > 128) {
          recentNewConversationRequests.delete(recentNewConversationRequests.keys().next().value!)
        }
        return { ...snapshot, projectRevision: projectRevisions.get(threadId) ?? 0 }
      })
    },

    async reconcileInterruptedRuns() {
      let reconciled = 0
      for (const threadId of await options.store.listThreadIds()) {
        await enqueue(threadId, async () => {
          const snapshot = await options.store.getThreadSnapshot(threadId)
          const shouldInterruptAndRotate = Boolean(
            snapshot.activeRun && !runs.has(snapshot.activeRun.id),
          )
          const shouldInvalidateSession =
            (await options.store.hasAvailableSessionContext?.(threadId)) ?? false
          if (shouldInterruptAndRotate) {
            await publishPayload(
              threadId,
              {
                type: 'run.interrupted',
                runId: snapshot.activeRun!.id,
                assistantText: '',
                error: '上次关闭 App 时，这项任务还没有完成。已完成的内容仍然保留。',
                createdAt: now(),
              },
              'durable',
            )
            reconciled += 1
          }
          if (shouldInvalidateSession && !shouldInterruptAndRotate) {
            await publishPayload(
              threadId,
              {
                type: 'session.invalidated',
                reason: 'app-restarted',
                createdAt: now(),
              },
              'durable',
            )
          }
          if (shouldInterruptAndRotate) {
            const rotated = await options.store.startNewConversation(threadId, now())
            const state: SegmentLiveState = {
              segmentId: rotated.segmentId,
              nextSeq: rotated.lastSeq + 1,
              ring: [],
            }
            states.set(threadId, state)
            const divider = rotated.history.at(-1)
            if (divider?.role === 'divider') {
              const envelope: AgentEventEnvelopeV1 = {
                schemaVersion: 1,
                eventId: `${rotated.segmentId}:${rotated.lastSeq}`,
                threadId,
                segmentId: rotated.segmentId,
                seq: rotated.lastSeq,
                durability: 'durable',
                occurredAt: divider.createdAt,
                payload: {
                  type: 'conversation.divider-added',
                  dividerId: divider.id,
                  createdAt: divider.createdAt,
                },
              }
              remember(state, envelope)
              try {
                options.broadcast(envelope)
              } catch {
                // startup reconciliation does not depend on a renderer.
              }
            }
            if (shouldInvalidateSession) {
              // The new segment's divider already expresses the restart boundary. Persist the
              // invalidation after rotation so the old interrupted card and the new divider do
              // not render as two adjacent conversation boundaries.
              await publishPayload(
                threadId,
                {
                  type: 'session.invalidated',
                  reason: 'app-restarted',
                  createdAt: now(),
                },
                'durable',
              )
            }
          }
        })
      }
      return reconciled
    },

    establishSessionContext(threadId, mode, compatibilityFingerprintHash, occurredAt = now()) {
      return enqueue(threadId, async () => {
        await publishPayload(
          threadId,
          {
            type: 'session.context-established',
            mode,
            compatibilityFingerprintHash,
            createdAt: occurredAt,
          },
          'durable',
        )
      })
    },

    invalidateSessionContext(threadId, reason, occurredAt = now()) {
      return enqueue(threadId, async () => {
        await publishPayload(
          threadId,
          {
            type: 'session.invalidated',
            reason,
            createdAt: occurredAt,
          },
          'durable',
        )
      })
    },
  }
}
