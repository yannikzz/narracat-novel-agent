import { describe, expect, test } from 'bun:test'

import { mergeIntervalsMs, parseSessionLines, piSessionsDir, summarizeSession } from './ops-write-timing.mjs'

/** 会话记录的真实形状：顶层 timestamp + message，assistant 的 toolCall 带 id/name/arguments。 */
function assistantMessage(timestamp, toolCalls = [], extra = {}) {
  return {
    type: 'message',
    timestamp,
    message: {
      role: 'assistant',
      model: 'deepseek-v4-pro',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      content: toolCalls.map((call) => ({ type: 'toolCall', ...call })),
      ...extra,
    },
  }
}

function toolResult(timestamp, toolCallId, extra = {}) {
  return { type: 'message', timestamp, message: { role: 'toolResult', toolCallId, ...extra } }
}

function task(id, agentId) {
  return { id, name: 'Task', arguments: { subagent_type: agentId } }
}

describe('mergeIntervalsMs', () => {
  test('重叠区间只算一次——并发派发不能逐个相加', () => {
    const overlapping = Array.from({ length: 4 }, () => ({ start: 0, end: 81_000 }))
    expect(mergeIntervalsMs(overlapping)).toBe(81_000)
  })

  test('不相接的区间相加，相接的合成一段', () => {
    expect(mergeIntervalsMs([{ start: 0, end: 10 }, { start: 20, end: 30 }])).toBe(20)
    expect(mergeIntervalsMs([{ start: 0, end: 10 }, { start: 5, end: 30 }])).toBe(30)
  })

  test('零长与倒置区间忽略', () => {
    expect(mergeIntervalsMs([{ start: 5, end: 5 }, { start: 10, end: 1 }])).toBe(0)
  })
})

describe('parseSessionLines', () => {
  test('跳过写坏的半行而不是整份放弃（会话可能被中断截断）', () => {
    const records = parseSessionLines('{"type":"session","id":"s1"}\n{坏行\n\n{"type":"message"}\n')
    expect(records).toEqual([{ type: 'session', id: 's1' }, { type: 'message' }])
  })
})

describe('summarizeSession', () => {
  test('子 agent 按 subagent_type 归因，并发派发按并集算挂钟', () => {
    const summary = summarizeSession([
      { type: 'session', id: 'sess-1' },
      assistantMessage('2026-08-19T12:00:00.000Z', [task('t1', 'narracat:memory-keeper'), task('t2', 'memory-keeper')]),
      toolResult('2026-08-19T12:01:21.000Z', 't1'),
      toolResult('2026-08-19T12:01:21.000Z', 't2'),
    ])

    expect(summary.sessionId).toBe('sess-1')
    // 两路并发各 81s：挂钟仍是 81s，逐次相加才是 162s
    expect(summary.subagentWallMs).toBe(81_000)
    expect(summary.subagentSumMs).toBe(162_000)
    // narracat: 前缀两种写法都归到同一个 agent
    expect(summary.byAgent).toEqual([{ agentId: 'memory-keeper', calls: 2, totalMs: 162_000, errors: 0 }])
  })

  test('与 Task 同批的本地工具不计时——整批共用写入时刻，会被最慢的派发拖长', () => {
    const summary = summarizeSession([
      // 模型在派发 Task 的同一条消息里调 TaskUpdate：真机上这让 TaskUpdate 背上了 273s
      assistantMessage('2026-08-19T12:00:00.000Z', [task('t1', 'chapter-writer'), { id: 'u1', name: 'TaskUpdate' }]),
      toolResult('2026-08-19T12:04:33.000Z', 't1'),
      toolResult('2026-08-19T12:04:33.000Z', 'u1'),
    ])

    expect(summary.subagentWallMs).toBe(273_000)
    expect(summary.localToolWallMs).toBe(0)
    expect(summary.localToolCalls).toBe(0)
    expect(summary.localToolShadowed).toBe(1)
  })

  test('纯本地工具批次照常计时', () => {
    const summary = summarizeSession([
      assistantMessage('2026-08-19T12:00:00.000Z', [{ id: 'r1', name: 'read' }]),
      toolResult('2026-08-19T12:00:00.500Z', 'r1'),
    ])

    expect(summary.localToolWallMs).toBe(500)
    expect(summary.localToolCalls).toBe(1)
    expect(summary.localToolShadowed).toBe(0)
  })

  test('模型调用耗时取与上一条消息的间隔，usage 与 model 累计', () => {
    const summary = summarizeSession([
      { type: 'message', timestamp: '2026-08-19T12:00:00.000Z', message: { role: 'user', content: [] } },
      assistantMessage('2026-08-19T12:00:12.000Z'),
      assistantMessage('2026-08-19T12:00:20.000Z'),
    ])

    expect(summary.modelCalls).toBe(2)
    expect(summary.modelMs).toBe(20_000)
    expect(summary.models).toEqual(['deepseek-v4-pro'])
    expect(summary.usage).toEqual({ input: 20, output: 10, cacheRead: 0, cacheWrite: 0 })
  })

  test('没等到结果的工具调用只计数、不计时（run 被中止或会话截断）', () => {
    const summary = summarizeSession([
      assistantMessage('2026-08-19T12:00:00.000Z', [task('t1', 'chapter-writer')]),
    ])

    expect(summary.unfinished).toBe(1)
    expect(summary.subagentWallMs).toBe(0)
  })

  test('失败的派发被标出来', () => {
    const summary = summarizeSession([
      assistantMessage('2026-08-19T12:00:00.000Z', [task('t1', 'chapter-writer')]),
      toolResult('2026-08-19T12:00:10.000Z', 't1', { isError: true }),
    ])

    expect(summary.subagents[0]).toEqual({ order: 1, agentId: 'chapter-writer', ms: 10_000, isError: true })
    expect(summary.byAgent[0].errors).toBe(1)
  })

  test('空会话不炸', () => {
    const summary = summarizeSession([])
    expect(summary.modelCalls).toBe(0)
    expect(summary.wallMs).toBe(0)
  })
})

describe('piSessionsDir', () => {
  const home = '/home/u'

  test('三个平台各走各的 userData 惯例', () => {
    expect(piSessionsDir('darwin', {}, home)).toBe('/home/u/Library/Application Support/NarraCat/pi-agent/sessions')
    expect(piSessionsDir('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home)).toContain('NarraCat')
    expect(piSessionsDir('linux', {}, home)).toBe('/home/u/.config/NarraCat/pi-agent/sessions')
  })

  test('Windows 缺 APPDATA 时回落到默认 Roaming 路径，不返回 undefined 拼接', () => {
    expect(piSessionsDir('win32', {}, home)).toBe('/home/u/AppData/Roaming/NarraCat/pi-agent/sessions')
  })
})
