// run 失败 → 埋点的完整链路：原始错误在哪一层蒸发成枚举码。
//
// 这条链跨两个模块，单看哪一头都证明不了红线成立：
//   agent-main-side-effects  把 run.failed 的 reason/error 原样交给埋点回调（仅进程内）
//   telemetry/failure-reason 把它归成枚举码，**原文到此为止**
//   telemetry-runtime        只发那个枚举
// 所以这里把两头接起来跑，断言"发出去的东西里没有任何一个字来自错误文本"。
//
// telemetry-runtime 本身依赖 electron app（userData 路径、isPackaged），在单测里起不来，
// 故这里复刻它那一步的做法（classifyRunFailure(event.failure ?? {})）而不是 import 它——
// 复刻的是一行调用，而被守的是"原文不出境"这件事，它由 classifyRunFailure 的返回值类型保证。

import { describe, expect, test } from 'bun:test'
import type { AgentEventEnvelopeV1, AgentRun } from '@shared/types/agent'
import type { ResultNotificationList } from '@shared/types/notifications'
import { TELEMETRY_FAILURE_REASONS } from '@shared/types/telemetry'
import { createAgentMainSideEffects, type RunTelemetryEvent } from '../agent/events/agent-main-side-effects.ts'
import { classifyRunFailure } from './failure-reason.ts'
import { isChapterWriteCommand, resolveRunModule } from './run-module.ts'

const EMPTY: ResultNotificationList = { notifications: [], totalCount: 0, unreadCount: 0 }

/**
 * durability 必须按事件类型给，不能按 seq 猜：side-effects 把 durable 与 transient 分派给
 * **两个不同的 handler**，终态只在 durable 那条里处理。把 run.failed 标成 transient，
 * 它会被静默忽略（不报错、也不触发埋点）——这一点踩过一次，留个注释免得再踩。
 */
const TRANSIENT_TYPES = new Set(['run.started', 'run.cancelling'])

function envelope(seq: number, payload: AgentEventEnvelopeV1['payload']): AgentEventEnvelopeV1 {
  return {
    schemaVersion: 1,
    eventId: `seg-00000000-0000-0000-0000-000000000001:${seq}`,
    threadId: 'novel:stars',
    segmentId: 'seg-00000000-0000-0000-0000-000000000001',
    runId: 'run-1',
    seq,
    durability: TRANSIENT_TYPES.has(payload.type) ? 'transient' : 'durable',
    occurredAt: payload.createdAt,
    payload,
  }
}

/** 跑一次「run 起 → 以失败收场」，返回埋点回调收到的事件。默认走写章节。 */
async function runFailure(
  failure: { error: string; reason?: string },
  command: AgentRun['command'] = 'write-next',
): Promise<RunTelemetryEvent[]> {
  const events: RunTelemetryEvent[] = []
  const handle = createAgentMainSideEffects({
    async upsertNotification() {
      return EMPTY
    },
    async markNotificationRead() {
      return EMPTY
    },
    broadcastNotifications() {},
    showNativeNotification() {},
    resolveProjectName: async () => '长夜星河',
    async clearPendingMemorySync() {},
    onRunTelemetryEvent: (event) => events.push(event),
  })

  await handle(
    envelope(1, {
      type: 'run.accepted',
      runId: 'run-1',
      command,
      visiblePrompt: '跑一次任务',
      createdAt: '2026-09-11T12:00:00.000Z',
    }),
  )
  await handle(
    envelope(2, {
      type: 'run.started',
      runId: 'run-1',
      threadId: 'novel:stars',
      command,
      prompt: '跑一次任务',
      projectPath: '/novels/stars',
      createdAt: '2026-09-11T12:00:00.000Z',
    }),
  )
  await handle(
    envelope(3, {
      type: 'run.failed',
      runId: 'run-1',
      assistantText: '',
      error: failure.error,
      ...(failure.reason ? { reason: failure.reason as 'max-turns' } : {}),
      createdAt: '2026-09-11T12:03:00.000Z',
    }),
  )

  return events
}

/** 复刻 telemetry-runtime 对失败事件的那一步，得到真正会被发出去的 props。 */
function reportedProps(event: RunTelemetryEvent): Record<string, string> {
  if (event.phase !== 'finished' || event.outcome !== 'failed') throw new Error('不是失败事件')
  return {
    code: 'run-failed',
    module: resolveRunModule(event.command),
    reason: classifyRunFailure(event.failure ?? {}),
  }
}

describe('run 失败 → 埋点：原始错误在哪一层蒸发', () => {
  test('#103 那条 terminated 被归成网络中断', async () => {
    const events = await runFailure({ error: 'Agent 运行失败：terminated' })
    const finished = events.find((event) => event.phase === 'finished')!

    expect(finished).toMatchObject({ phase: 'finished', outcome: 'failed' })
    expect(reportedProps(finished).reason).toBe('network-interrupted')
  })

  test('结构化 reason 原样透传给分类（回合上限）', async () => {
    const events = await runFailure({ error: '本次运行达到回合上限', reason: 'max-turns' })
    const finished = events.find((event) => event.phase === 'finished')!

    expect(reportedProps(finished).reason).toBe('max-turns')
  })

  // 红线的核心断言：模型报错里夹带正文是真实发生过的事（ADR-0039 决定九就是为此不开自动堆栈捕获）。
  // 这里让错误文本整段是小说正文，断言它一个字都没进最终 props。
  test('错误里夹带正文时，发出去的 props 一个字都不沾', async () => {
    const prose = '林舟握紧了剑，风雪扑面而来。他知道这一战避无可避。'
    const events = await runFailure({ error: `${prose}\n400 Bad Request` })
    const finished = events.find((event) => event.phase === 'finished')!

    // 进程内部这一层确实拿到了原文——它是分类的依据
    expect(finished.phase === 'finished' && finished.failure?.error).toContain('林舟')

    // 但发出去的只有枚举
    const props = reportedProps(finished)
    expect(props).toEqual({ code: 'run-failed', module: 'write-chapter', reason: 'provider-bad-request' })
    const serialized = JSON.stringify(props)
    for (const fragment of ['林舟', '剑', '风雪', '避无可避', prose]) {
      expect(serialized).not.toContain(fragment)
    }
  })

  test('无论失败长什么样，reason 恒为枚举表里的值', async () => {
    for (const error of ['terminated', '429 rate limit', '莫名其妙的错', '', '正文正文正文']) {
      const events = await runFailure({ error })
      const finished = events.find((event) => event.phase === 'finished')!
      expect(TELEMETRY_FAILURE_REASONS).toContain(reportedProps(finished).reason)
    }
  })

  // 这半是 2026-09-11 加的：此前 error_occurred 全库只在写章节失败时上报一处，
  // 「立项卡跑失败了」这类事一条记录都没有——而 premise 是第二大模块（128 台设备用过，
  // 写章节只有 64 台），盲区正好压在最常走的那条路上。
  test('立项卡失败也上报，落 premise 模块', async () => {
    const events = await runFailure({ error: '401 Unauthorized' }, 'setup')
    const finished = events.find((event) => event.phase === 'finished')!

    expect(reportedProps(finished)).toEqual({
      code: 'run-failed',
      module: 'premise',
      reason: 'provider-auth',
    })
  })

  test('大纲 / 参考作品 / 记忆同步各归其位', async () => {
    for (const [command, module] of [
      ['plan', 'outline'],
      ['reference', 'reference-works'],
      ['sync-chapter-memory', 'memory-graph'],
    ] as const) {
      const events = await runFailure({ error: 'terminated' }, command)
      const finished = events.find((event) => event.phase === 'finished')!
      expect(reportedProps(finished).module).toBe(module)
    }
  })

  test('世界观与自由对话落 unknown（没有对应模块，刻意不新增）', async () => {
    for (const command of ['world', 'freeform'] as const) {
      const events = await runFailure({ error: 'terminated' }, command)
      const finished = events.find((event) => event.phase === 'finished')!
      expect(reportedProps(finished).module).toBe('unknown')
    }
  })

  // 回归保护：扩大失败上报**不能**把别的 command 混进写章节的两个事件里。
  // 那两个数（完成率、耗时分布）是跨版本比较用的，口径一变就不可比。
  test('非写章节的 run 不算一次写章节', async () => {
    for (const command of ['setup', 'plan', 'rewrite', 'review', 'world'] as const) {
      expect(isChapterWriteCommand(command)).toBe(false)
    }
    expect(isChapterWriteCommand('write-next')).toBe(true)

    // side-effects 仍然对所有 command 发事件，门禁在埋点层——这里确认 command 被如实带出
    const events = await runFailure({ error: 'terminated' }, 'setup')
    expect(events.every((event) => event.command === 'setup')).toBe(true)
    expect(events.some((event) => event.phase === 'started')).toBe(true)
  })

  test('成功收场不带 failure、也不报错误事件', async () => {
    const events: RunTelemetryEvent[] = []
    const handle = createAgentMainSideEffects({
      async upsertNotification() {
        return EMPTY
      },
      async markNotificationRead() {
        return EMPTY
      },
      broadcastNotifications() {},
      showNativeNotification() {},
      resolveProjectName: async () => '长夜星河',
      async clearPendingMemorySync() {},
      onRunTelemetryEvent: (event) => events.push(event),
    })

    await handle(
      envelope(1, {
        type: 'run.accepted',
        runId: 'run-1',
        command: 'write-next',
        visiblePrompt: '写下一章',
        createdAt: '2026-09-11T12:00:00.000Z',
      }),
    )
    await handle(
      envelope(2, {
        type: 'run.started',
        runId: 'run-1',
        threadId: 'novel:stars',
        command: 'write-next',
        prompt: '写下一章',
        projectPath: '/novels/stars',
        createdAt: '2026-09-11T12:00:00.000Z',
      }),
    )
    await handle(
      envelope(3, {
        type: 'run.completed',
        runId: 'run-1',
        assistantText: '第 12 章已完成',
        createdAt: '2026-09-11T12:05:00.000Z',
      }),
    )

    const finished = events.find((event) => event.phase === 'finished')!
    expect(finished).toMatchObject({ phase: 'finished', outcome: 'success' })
    expect(finished.phase === 'finished' && finished.failure).toBeUndefined()
  })
})
