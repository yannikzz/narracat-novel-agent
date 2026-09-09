import { describe, expect, test } from 'bun:test'
import { formatAgentRunEndLog, formatAgentRunNoTerminalLog, formatAgentRunStartLog } from './run-log.ts'

const START_BASE = {
  runId: 'run-1',
  threadId: 'novel:novel-f200e083',
  command: 'plan',
  path: 'narracat-command' as const,
  maxTurns: 72,
  runtimeId: 'pi',
  loadNarraCatRuntime: true,
  resumed: false,
}

describe('formatAgentRunStartLog', () => {
  test('记下归因需要的六个决定：路径、命令、回合预算、运行时、引擎、线程', () => {
    const line = formatAgentRunStartLog(START_BASE)

    expect(line).toBe(
      '[agent-run] 开始 runId=run-1 path=narracat-command command=plan maxTurns=72 runtime=pi engine=on resume=no thread=novel:novel-f200e083',
    )
  })

  test('缺省预算记成 default 而不是省略——「没传」与「传了 12」是两件事', () => {
    // direct-chat 不传 maxTurns，落到 adapter 的 DEFAULT_PI_MAX_TURNS。日志若省略这个字段，
    // 读日志的人无从判断预算到底是多少，#94 正是卡在这里。
    const line = formatAgentRunStartLog({
      ...START_BASE,
      path: 'direct-chat',
      command: 'freeform',
      maxTurns: undefined,
      loadNarraCatRuntime: false,
    })

    expect(line).toContain('maxTurns=default')
    expect(line).toContain('engine=off')
  })

  test('章号只在有值时出现', () => {
    expect(formatAgentRunStartLog({ ...START_BASE, selectedChapter: 15 })).toContain('chapter=15')
    expect(formatAgentRunStartLog(START_BASE)).not.toContain('chapter=')
  })

  test('续聊路径标 resume=yes', () => {
    expect(formatAgentRunStartLog({ ...START_BASE, path: 'resumed-command', resumed: true })).toContain('resume=yes')
  })

  test('不带作者写的字：prompt 一律不进日志', () => {
    // 防回归：这个函数的入参里就不该出现 prompt。真加进来时这条会红。
    expect(Object.keys(START_BASE)).not.toContain('prompt')
    expect(formatAgentRunStartLog(START_BASE)).not.toContain('prompt')
  })
})

describe('formatAgentRunEndLog', () => {
  test('回合上限：机器可读的 reason 落进日志，与开始行的 maxTurns 合成完整现场（#94）', () => {
    const line = formatAgentRunEndLog({
      runId: 'run-1',
      terminal: {
        type: 'run.failed',
        runId: 'run-1',
        error: 'Agent 本次运行达到回合上限，请稍后重试或提高运行上限。',
        reason: 'max-turns',
        createdAt: '2026-09-09T00:00:00.000Z',
      },
      elapsedMs: 3_601_000,
    })

    expect(line).toContain('终态=failed')
    expect(line).toContain('reason=max-turns')
    expect(line).toContain('耗时=3601.0s')
    expect(line).toContain('error=Agent 本次运行达到回合上限，请稍后重试或提高运行上限。')
  })

  test('完成态没有 reason / error 字段时不硬凑', () => {
    const line = formatAgentRunEndLog({
      runId: 'run-2',
      terminal: {
        type: 'run.completed',
        runId: 'run-2',
        assistantText: '写完了',
        createdAt: '2026-09-09T00:00:00.000Z',
      },
      elapsedMs: 12_340,
    })

    expect(line).toBe('[agent-run] 结束 runId=run-2 终态=completed 耗时=12.3s')
  })

  test('长错误只留首行且截断：日志是索引不是全文', () => {
    const line = formatAgentRunEndLog({
      runId: 'run-3',
      terminal: {
        type: 'run.failed',
        runId: 'run-3',
        error: `${'长'.repeat(400)}\n第二行不该出现`,
        createdAt: '2026-09-09T00:00:00.000Z',
      },
      elapsedMs: 1_000,
    })

    expect(line).not.toContain('第二行不该出现')
    expect(line).toContain('…')
    expect(line.length).toBeLessThan(300)
  })
})

describe('formatAgentRunNoTerminalLog', () => {
  test('开始了却没有终态，要在日志里看得见', () => {
    expect(formatAgentRunNoTerminalLog('run-4', 500)).toBe('[agent-run] 结束 runId=run-4 终态=none 耗时=0.5s')
  })
})
