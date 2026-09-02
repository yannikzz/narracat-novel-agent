import type {
  AgentDurableEventV1,
  AgentEvent,
  AgentEventEnvelopeV1,
  AgentRun,
} from '@shared/types/agent'
import {
  createQuestionNotificationDraft,
  createResultNotificationDraft,
  resultNotificationIdForRun,
} from '@shared/lib/result-notifications'
import type {
  ResultNotification,
  ResultNotificationList,
  ResultNotificationStatus,
} from '@shared/types/notifications'

/**
 * 写章节的埋点回调（ADR-0039）。这一层已经掌握了 run 的起止与终态（结果通知就靠它），
 * 埋点复用同一处判定，避免在 run-manager 里再钉一套平行的生命周期钩子。
 * 只在 command 为 write-next 时触发；不传即不埋（测试与非埋点场景）。
 */
export type ChapterWriteTelemetryEvent =
  | { phase: 'started'; chapter?: number }
  | { phase: 'finished'; outcome: 'success' | 'failed' | 'cancelled' | 'interrupted'; durationMs: number }

export interface AgentMainSideEffectsDeps {
  upsertNotification: (notification: ResultNotification) => Promise<ResultNotificationList>
  markNotificationRead: (id: string, readAt: string) => Promise<ResultNotificationList>
  broadcastNotifications: (notifications: ResultNotificationList) => void
  showNativeNotification: (notification: ResultNotification) => void | Promise<void>
  resolveProjectName: (projectPath: string) => Promise<string>
  clearPendingMemorySync: (projectPath: string, chapter: number) => Promise<void>
  onChapterWriteEvent?: (event: ChapterWriteTelemetryEvent) => void
  /**
   * 写章节成功收场后的钩子（ADR-0041 常驻润色的挂载点）。
   * 复用这一层已有的 run 终态判定，不在 run-manager 里另钉一套生命周期。
   */
  onChapterWriteCompleted?: (input: { projectPath: string; startedAt: string; finishedAt: string }) => void
}

function fallbackProjectName(projectPath: string | undefined): string {
  if (!projectPath) return '未关联项目'
  return projectPath.split(/[\\/]+/).filter(Boolean).at(-1) ?? '未关联项目'
}

function activityNotification(
  run: AgentRun,
  status: Extract<ResultNotificationStatus, 'running' | 'cancelling'>,
  occurredAt: string,
  projectName: string,
  title?: string,
): ResultNotification {
  return {
    id: resultNotificationIdForRun(run.id),
    runId: run.id,
    threadId: run.threadId,
    status,
    title: title ?? (status === 'cancelling' ? 'Agent 正在停止' : 'Agent 正在执行任务'),
    summary: status === 'cancelling' ? '正在等待底层执行与清理完成。' : '任务正在后台执行。',
    projectName,
    ...(run.projectPath ? { projectPath: run.projectPath } : {}),
    command: run.command,
    ...(run.target ? { target: run.target } : {}),
    createdAt: occurredAt,
    updatedAt: occurredAt,
  }
}

export function createAgentMainSideEffects(deps: AgentMainSideEffectsDeps) {
  const runs = new Map<string, AgentRun>()

  /** 埋点是旁路观察者：抛异常也不许影响通知与后续副作用。 */
  function emitChapterWrite(run: AgentRun, event: ChapterWriteTelemetryEvent): void {
    if (run.command !== 'write-next' || !deps.onChapterWriteEvent) return
    try {
      deps.onChapterWriteEvent(event)
    } catch {}
  }

  /** run 起止时刻差；任一端解析不出来按 0 计（会落进最小的时长桶，不会伪造一个大数）。 */
  function elapsedMs(run: AgentRun, finishedAt: string): number {
    const start = Date.parse(run.startedAt)
    const end = Date.parse(finishedAt)
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 0
  }

  async function projectNameFor(run: AgentRun): Promise<string> {
    if (!run.projectPath) return '未关联项目'
    return deps.resolveProjectName(run.projectPath).catch(() => fallbackProjectName(run.projectPath))
  }

  async function retryOnce(operation: () => void | Promise<void>): Promise<void> {
    try {
      await operation()
    } catch {
      await operation()
    }
  }

  async function runIndependentSideEffects(operations: Array<() => void | Promise<void>>): Promise<void> {
    const errors: unknown[] = []
    for (const operation of operations) {
      try {
        await operation()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Agent 主进程副作用未全部完成。')
  }

  async function upsertAndBroadcast(notification: ResultNotification): Promise<void> {
    await retryOnce(async () => {
      const list = await deps.upsertNotification(notification)
      deps.broadcastNotifications(list)
    })
  }

  function runFor(runId: string, threadId: string, createdAt: string): AgentRun {
    return (
      runs.get(runId) ?? {
        id: runId,
        threadId,
        command: 'freeform',
        prompt: '',
        status: 'running',
        startedAt: createdAt,
      }
    )
  }

  async function handleDurable(envelope: AgentEventEnvelopeV1, payload: AgentDurableEventV1): Promise<void> {
    if (payload.type === 'run.accepted') {
      runs.set(payload.runId, {
        id: payload.runId,
        threadId: envelope.threadId,
        command: payload.command,
        prompt: payload.visiblePrompt,
        displayPrompt: payload.visiblePrompt,
        status: 'accepted',
        startedAt: payload.createdAt,
        selectedChapter: payload.selectedChapter,
        target: payload.target,
      })
      return
    }

    if (payload.type === 'run.question-requested') {
      const run = runFor(payload.runId, envelope.threadId, payload.createdAt)
      runs.set(payload.runId, { ...run, status: 'waiting-user' })
      const notification = {
        ...createQuestionNotificationDraft({
          run,
          projectName: await projectNameFor(run),
          occurredAt: payload.createdAt,
          questionRequestId: payload.questionRequestId,
          questions: payload.questions,
        }),
        segmentId: envelope.segmentId,
      }
      await runIndependentSideEffects([
        () => upsertAndBroadcast(notification),
        () => deps.showNativeNotification(notification),
      ])
      return
    }

    if (payload.type === 'run.question-answered') {
      const run = runFor(payload.runId, envelope.threadId, payload.createdAt)
      runs.set(payload.runId, { ...run, status: 'running' })
      const list = await deps.markNotificationRead(resultNotificationIdForRun(payload.runId), payload.createdAt)
      deps.broadcastNotifications(list)
      await upsertAndBroadcast(
        {
          ...activityNotification(run, 'running', payload.createdAt, await projectNameFor(run)),
          segmentId: envelope.segmentId,
        },
      )
      return
    }

    if (
      payload.type !== 'run.completed' &&
      payload.type !== 'run.failed' &&
      payload.type !== 'run.cancelled' &&
      payload.type !== 'run.interrupted'
    ) {
      return
    }

    const run = runFor(payload.runId, envelope.threadId, payload.createdAt)
    if (payload.type === 'run.cancelled') {
      const cancelled = activityNotification(
        { ...run, status: 'cancelled', finishedAt: payload.createdAt },
        'cancelling',
        payload.createdAt,
        await projectNameFor(run),
        'Agent 任务已取消',
      )
      cancelled.segmentId = envelope.segmentId
      cancelled.readAt = payload.createdAt
      await upsertAndBroadcast(cancelled)
      runs.set(payload.runId, { ...run, status: 'cancelled', finishedAt: payload.createdAt })
      emitChapterWrite(run, {
        phase: 'finished',
        outcome: 'cancelled',
        durationMs: elapsedMs(run, payload.createdAt),
      })
      return
    }

    const status =
      payload.type === 'run.completed'
        ? 'success'
        : payload.type === 'run.interrupted'
          ? 'interrupted'
          : 'failed'
    const terminalRun: AgentRun = {
      ...run,
      status:
        payload.type === 'run.completed'
          ? 'complete'
          : payload.type === 'run.interrupted'
            ? 'interrupted'
            : 'failed',
      finishedAt: payload.createdAt,
    }
    runs.set(payload.runId, terminalRun)
    emitChapterWrite(run, {
      phase: 'finished',
      outcome: payload.type === 'run.completed' ? 'success' : payload.type === 'run.interrupted' ? 'interrupted' : 'failed',
      durationMs: elapsedMs(run, payload.createdAt),
    })
    const notification = createResultNotificationDraft({
      run: terminalRun,
      status,
      projectName: await projectNameFor(terminalRun),
      occurredAt: payload.createdAt,
      ...(payload.type === 'run.failed' ? { error: payload.error } : {}),
    })
    notification.segmentId = envelope.segmentId
    const operations: Array<() => void | Promise<void>> = [
      () => upsertAndBroadcast(notification),
    ]
    if (
      payload.type === 'run.completed' &&
      run.command === 'sync-chapter-memory' &&
      run.projectPath &&
      typeof run.selectedChapter === 'number'
    ) {
      const projectPath = run.projectPath
      const selectedChapter = run.selectedChapter
      operations.push(() =>
        retryOnce(() => deps.clearPendingMemorySync(projectPath, selectedChapter)),
      )
    }
    // recover-write 与 write-next 同样产出正文（两条 run 路径都标 manuscriptRevisionSource:
    // 'agent-write'），只判前者会让「恢复写作」写出来的新章拿不到常驻润色。
    if (
      payload.type === 'run.completed' &&
      (run.command === 'write-next' || run.command === 'recover-write') &&
      run.projectPath
    ) {
      const projectPath = run.projectPath
      // 旁路：常驻润色失败绝不影响通知与写作链路收尾，故不进 runIndependentSideEffects。
      try {
        // 带上 run 的起止时刻：写作命令有「先不写」这条出口，run 照样正常结束，
        // 下游据此判断这一章的正文是不是真的在**本次 run 期间**落盘。两头都要——只判起点的话，
        // 下一轮很快写出的正文也会被这一轮迟到的常驻检查错认成自己的。
        deps.onChapterWriteCompleted?.({ projectPath, startedAt: run.startedAt, finishedAt: payload.createdAt })
      } catch {}
    }
    operations.push(() => deps.showNativeNotification(notification))
    await runIndependentSideEffects(operations)

    if (runs.size > 512) runs.delete(runs.keys().next().value!)
  }

  async function handleTransient(envelope: AgentEventEnvelopeV1, event: AgentEvent): Promise<void> {
    if (event.type === 'run.started') {
      const existing = runFor(event.runId, event.threadId, event.createdAt)
      const run: AgentRun = {
        ...existing,
        threadId: event.threadId,
        command: event.command,
        prompt: event.prompt,
        displayPrompt: event.displayPrompt,
        status: 'running',
        projectPath: event.projectPath,
        selectedChapter: event.selectedChapter,
        target: event.target,
      }
      runs.set(event.runId, run)
      emitChapterWrite(run, { phase: 'started', chapter: run.selectedChapter })
      await upsertAndBroadcast(
        {
          ...activityNotification(run, 'running', event.createdAt, await projectNameFor(run)),
          segmentId: envelope.segmentId,
        },
      )
      return
    }
    if (event.type === 'run.cancelling') {
      const run = runFor(event.runId, envelope.threadId, event.createdAt)
      runs.set(event.runId, { ...run, status: 'cancelling' })
      await upsertAndBroadcast(
        {
          ...activityNotification(run, 'cancelling', event.createdAt, await projectNameFor(run)),
          segmentId: envelope.segmentId,
        },
      )
    }
  }

  return async (envelope: AgentEventEnvelopeV1): Promise<void> => {
    if (envelope.durability === 'durable') {
      await handleDurable(envelope, envelope.payload as AgentDurableEventV1)
    } else {
      await handleTransient(envelope, envelope.payload as AgentEvent)
    }
  }
}
