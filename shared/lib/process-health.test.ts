import { describe, expect, test } from 'bun:test'
import type { ProcessHealthEvent } from '@shared/types/process-health'
import {
  describeReasonForAuthor,
  isAbnormalReason,
  parseProcessHealthEvents,
  retainRecentEvents,
  shouldPromptAuthor,
  summarizeProcessHealthEvent,
} from './process-health'

describe('isAbnormalReason', () => {
  test('clean-exit 不算异常——关窗口与正常 reload 都会触发它', () => {
    expect(isAbnormalReason('clean-exit')).toBe(false)
  })

  test('其余原因都要留痕', () => {
    for (const reason of [
      'abnormal-exit',
      'killed',
      'crashed',
      'oom',
      'launch-failed',
      'integrity-failure',
      'memory-eviction',
    ] as const) {
      expect(isAbnormalReason(reason)).toBe(true)
    }
  })
})

describe('shouldPromptAuthor', () => {
  test('界面真的没了才打断作者', () => {
    for (const reason of ['crashed', 'oom', 'abnormal-exit', 'killed'] as const) {
      expect(shouldPromptAuthor(reason)).toBe(true)
    }
  })

  test('clean-exit 不提示——否则每次关窗都弹一个「崩溃了」的框', () => {
    expect(shouldPromptAuthor('clean-exit')).toBe(false)
  })

  test('memory-eviction 只留痕不提示：系统回收后台页面，Electron 会自行恢复', () => {
    expect(shouldPromptAuthor('memory-eviction')).toBe(false)
    expect(isAbnormalReason('memory-eviction')).toBe(true)
  })
})

describe('describeReasonForAuthor', () => {
  test('给作者的话里不出现 reason 原文这类技术黑话', () => {
    for (const reason of ['crashed', 'oom', 'killed', 'launch-failed', 'integrity-failure'] as const) {
      const message = describeReasonForAuthor(reason)
      expect(message).not.toContain(reason)
      expect(message.length).toBeGreaterThan(0)
    }
  })
})

describe('summarizeProcessHealthEvent', () => {
  test('渲染进程退出保留 reason 与 exitCode，供回传排查', () => {
    const summary = summarizeProcessHealthEvent({
      kind: 'renderer-gone',
      at: '2026-08-25T10:30:00.000Z',
      reason: 'crashed',
      exitCode: 133,
    })

    expect(summary).toContain('2026-08-25 10:30:00')
    expect(summary).toContain('crashed')
    expect(summary).toContain('133')
  })

  test('子进程退出优先显示进程名，退化到进程类型', () => {
    const named = summarizeProcessHealthEvent({
      kind: 'child-gone',
      at: '2026-08-25T10:30:00.000Z',
      reason: 'crashed',
      exitCode: 1,
      processType: 'Utility',
      processName: 'Node Utility Process',
    })
    expect(named).toContain('Node Utility Process')

    const unnamed = summarizeProcessHealthEvent({
      kind: 'child-gone',
      at: '2026-08-25T10:30:00.000Z',
      reason: 'crashed',
      exitCode: 1,
      processType: 'GPU',
    })
    expect(unnamed).toContain('GPU')
  })

  test('主线程阻塞显示秒数；一直没恢复显示「未恢复」而不是 0s', () => {
    expect(
      summarizeProcessHealthEvent({
        kind: 'main-thread-blocked',
        at: '2026-08-25T10:30:00.000Z',
        blockedMs: 8_400,
      }),
    ).toContain('8s')

    expect(
      summarizeProcessHealthEvent({
        kind: 'main-thread-blocked',
        at: '2026-08-25T10:30:00.000Z',
      }),
    ).toContain('未恢复')
  })
})

describe('retainRecentEvents', () => {
  const event = (at: string): ProcessHealthEvent => ({ kind: 'renderer-gone', at, reason: 'crashed', exitCode: 1 })

  test('最近的在前', () => {
    const result = retainRecentEvents([event('older')], event('newer'))
    expect(result.map((item) => item.at)).toEqual(['newer', 'older'])
  })

  test('超出上限的丢弃，避免记录文件无限增长', () => {
    const existing = Array.from({ length: 50 }, (_, index) => event(`old-${index}`))
    const result = retainRecentEvents(existing, event('newest'), 50)

    expect(result).toHaveLength(50)
    expect(result[0].at).toBe('newest')
    expect(result.at(-1)?.at).toBe('old-48')
  })
})

describe('parseProcessHealthEvents', () => {
  test('损坏的 JSON 当作没有记录——取证不该成为启动失败的原因', () => {
    expect(parseProcessHealthEvents('{ 不是 json')).toEqual([])
    expect(parseProcessHealthEvents('{"not":"an array"}')).toEqual([])
  })

  test('过滤掉形状不对的条目，保留合法的', () => {
    const raw = JSON.stringify([
      { kind: 'renderer-gone', at: '2026-08-25T10:30:00.000Z', reason: 'crashed', exitCode: 1 },
      { garbage: true },
      null,
    ])

    const parsed = parseProcessHealthEvents(raw)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].kind).toBe('renderer-gone')
  })
})
