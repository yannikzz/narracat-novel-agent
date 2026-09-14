// 「一次 run 该发哪些埋点」的守卫。
//
// **这个文件存在的理由**：此前这段判断住在 telemetry-runtime.ts 里，而那个文件依赖 electron
// 的 app，单测起不来，于是整段分支零覆盖。端到端测试里有一份「复刻生产代码那一行」的辅助函数，
// 看着像在守红线，实际只守住了复刻。变异实验证实：把 `reason: classifyRunFailure(...)` 换成
// `reason: event.failure?.error`（原始错误文本直接出境，红线当场破），整套测试照样全绿。
//
// 现在判断全在 planRunTelemetry 这个纯函数里，这里测的就是生产路径本身。

import { describe, expect, test } from 'bun:test'
import type { AgentRun } from '@shared/types/agent'
import { TELEMETRY_ALLOWED_PROP_KEYS, TELEMETRY_FAILURE_REASONS } from '@shared/types/telemetry'
import { planRunTelemetry, UNKNOWN_MODEL } from './run-telemetry-plan.ts'

const MODEL = { provider: 'deepseek', model_id: 'deepseek-v4-pro' }

function started(command: AgentRun['command'], chapter?: number) {
  return planRunTelemetry({ phase: 'started', command, ...(chapter ? { chapter } : {}) }, MODEL)
}

function finished(
  command: AgentRun['command'],
  outcome: 'success' | 'failed' | 'cancelled' | 'interrupted',
  failure?: { reason?: string; error?: string },
) {
  return planRunTelemetry(
    { phase: 'finished', command, outcome, durationMs: 120_000, ...(failure ? { failure } : {}) },
    MODEL,
  )
}

const names = (plan: { events: Array<{ event: string }> }) => plan.events.map((e) => e.event)

describe('写章节的两个事件：口径不能被稀释', () => {
  // 这两个数（完成率、耗时分布）是跨版本比较用的。rewrite/review 同属 write-chapter 模块
  // 但不是「写新的一章」，混进去就不可比了——与「分桶边界一旦发布就不要改」同一个道理。
  test('只有 write-next 发', () => {
    expect(names(started('write-next'))).toEqual(['chapter_write_started'])
    expect(names(finished('write-next', 'success'))).toEqual(['chapter_write_finished'])
  })

  test('rewrite / review / recover-write 一概不发', () => {
    for (const command of ['rewrite', 'review', 'recover-write'] as const) {
      expect(names(started(command))).toEqual([])
      expect(names(finished(command, 'success'))).toEqual([])
    }
  })

  test('起点只为写章节补 feature_used', () => {
    expect(started('write-next').featureUsed).toBe('write-chapter')
    for (const command of ['setup', 'plan', 'rewrite', 'world'] as const) {
      expect(started(command).featureUsed).toBeUndefined()
    }
  })

  test('章节号落分桶，不发真实数字', () => {
    const plan = started('write-next', 42)
    expect(plan.events[0].props).toMatchObject({ chapter_bucket: '21-100' })
    expect(JSON.stringify(plan.events[0].props)).not.toContain('42')
  })
})

describe('失败上报覆盖全部 command', () => {
  test('立项卡失败落 premise', () => {
    const plan = finished('setup', 'failed', { error: '401 Unauthorized' })
    expect(names(plan)).toEqual(['error_occurred'])
    expect(plan.events[0].props).toEqual({
      code: 'run-failed',
      module: 'premise',
      reason: 'provider-auth',
    })
  })

  test('写章节失败同时发两条：完成态 + 错误', () => {
    const plan = finished('write-next', 'failed', { error: 'terminated' })
    expect(names(plan)).toEqual(['chapter_write_finished', 'error_occurred'])
  })

  test('各 command 各归其位', () => {
    for (const [command, module] of [
      ['plan', 'outline'],
      ['reference', 'reference-works'],
      ['sync-chapter-memory', 'memory-graph'],
      ['revise-premise', 'premise'],
      ['world', 'unknown'],
      ['freeform', 'unknown'],
    ] as const) {
      const plan = finished(command, 'failed', { error: 'terminated' })
      expect(plan.events[0].props).toMatchObject({ module })
    }
  })

  test('成功 / 取消 / 中断都不记错误', () => {
    for (const outcome of ['success', 'cancelled', 'interrupted'] as const) {
      expect(names(finished('setup', outcome))).toEqual([])
      expect(names(finished('write-next', outcome))).toEqual(['chapter_write_finished'])
    }
  })
})

describe('红线：原始错误文本不出境', () => {
  // 模型报错里夹带正文是真实发生过的事（ADR-0039 决定九就是为此不开自动堆栈捕获）。
  test('错误整段是小说正文时，props 一个字都不沾', () => {
    const prose = '林舟握紧了剑，风雪扑面而来。他知道这一战避无可避。'
    const plan = finished('setup', 'failed', { error: `${prose}\n400 Bad Request` })

    expect(plan.events[0].props).toEqual({
      code: 'run-failed',
      module: 'premise',
      reason: 'provider-bad-request',
    })
    const serialized = JSON.stringify(plan.events)
    for (const fragment of ['林舟', '剑', '风雪', '避无可避', prose]) {
      expect(serialized).not.toContain(fragment)
    }
  })

  test('无论失败长什么样，产出的每个值都只可能是枚举或分桶名', () => {
    const nasty = [
      '',
      'terminated',
      '正文正文正文',
      'sk-proj-abcdefghijklmnop',
      'C:\\Users\\某人\\Documents\\我的小说\\第一章.md',
      'x'.repeat(500),
    ]
    for (const error of nasty) {
      const plan = finished('setup', 'failed', { error })
      const props = plan.events[0].props as Record<string, string>
      expect(TELEMETRY_FAILURE_REASONS).toContain(props.reason)
      // 逐个值核对：没有任何一项来自入参
      for (const value of Object.values(props)) {
        expect(error.includes(value)).toBe(false)
      }
    }
  })

  test('产出的字段名全部在白名单内', () => {
    const plans = [started('write-next', 3), finished('write-next', 'failed', { error: 'terminated' })]
    for (const plan of plans) {
      for (const event of plan.events) {
        const allowed = TELEMETRY_ALLOWED_PROP_KEYS[event.event]
        for (const key of Object.keys(event.props)) {
          expect(allowed).toContain(key)
        }
      }
    }
  })
})

describe('只在需要时才去读模型配置', () => {
  // 非写章节的 run 用不到模型标识，没必要为它读一次配置文件。
  test('写章节要，其余不要', () => {
    expect(started('write-next').needsModel).toBe(true)
    expect(finished('write-next', 'failed', { error: 'x' }).needsModel).toBe(true)
    for (const command of ['setup', 'plan', 'world'] as const) {
      expect(started(command).needsModel).toBe(false)
      expect(finished(command, 'failed', { error: 'x' }).needsModel).toBe(false)
    }
  })

  test('用占位模型问一次的结果，与真模型的事件形状一致', () => {
    const probe = planRunTelemetry({ phase: 'started', command: 'setup' }, UNKNOWN_MODEL)
    expect(probe.events).toEqual([])
    expect(probe.needsModel).toBe(false)
  })
})
