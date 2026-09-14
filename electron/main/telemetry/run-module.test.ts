import { describe, expect, test } from 'bun:test'
import type { AgentRun } from '@shared/types/agent'
import { TELEMETRY_MODULES } from '@shared/types/telemetry'
import { isChapterWriteCommand, resolveRunModule } from './run-module.ts'

/** run.command 的全集。新增 command 时这里会先红，提醒补映射。 */
const ALL_COMMANDS: ReadonlyArray<AgentRun['command']> = [
  'setup',
  'reference',
  'world',
  'plan',
  'write-next',
  'recover-write',
  'rewrite',
  'review',
  'revise-premise',
  'sync-chapter-memory',
  'freeform',
]

describe('command → 埋点模块', () => {
  test('立项相关都落 premise', () => {
    expect(resolveRunModule('setup')).toBe('premise')
    expect(resolveRunModule('revise-premise')).toBe('premise')
  })

  test('写章节相关都落 write-chapter', () => {
    for (const command of ['write-next', 'recover-write', 'rewrite', 'review'] as const) {
      expect(resolveRunModule(command)).toBe('write-chapter')
    }
  })

  test('其余各归其位', () => {
    expect(resolveRunModule('plan')).toBe('outline')
    expect(resolveRunModule('reference')).toBe('reference-works')
    expect(resolveRunModule('sync-chapter-memory')).toBe('memory-graph')
  })

  // TELEMETRY_MODULES 里没有对应项。新增模块取值属于扩大采集范围，要走 ADR-0039 的告知流程，
  // 所以先落 unknown——失败本身看得见，只是不知道具体是哪一类。
  test('world 与 freeform 落 unknown（刻意，不是漏了）', () => {
    expect(resolveRunModule('world')).toBe('unknown')
    expect(resolveRunModule('freeform')).toBe('unknown')
  })

  test('每个 command 都有映射，且取值合法', () => {
    for (const command of ALL_COMMANDS) {
      const module = resolveRunModule(command)
      expect(module === 'unknown' || TELEMETRY_MODULES.includes(module)).toBe(true)
    }
  })

  test('没登记过的 command 兜底到 unknown 而不是 undefined', () => {
    expect(resolveRunModule('brand-new-command' as AgentRun['command'])).toBe('unknown')
  })
})

describe('谁算"写了一章"', () => {
  // 这两个事件是跨版本比较完成率与耗时分布用的，口径一旦变了就不可比
  // （与分桶边界不许改是同一个道理）。
  test('只有 write-next 会发 chapter_write_* 两个事件', () => {
    expect(isChapterWriteCommand('write-next')).toBe(true)
    for (const command of ALL_COMMANDS.filter((c) => c !== 'write-next')) {
      expect(isChapterWriteCommand(command)).toBe(false)
    }
  })

  // 最容易搞错的一条：rewrite / review 同属 write-chapter 模块，但不是"写新的一章"。
  // 按模块判断就会把它们混进完成率，把那个数稀释掉。
  test('同属 write-chapter 模块 ≠ 算一次写章节', () => {
    for (const command of ['rewrite', 'review', 'recover-write'] as const) {
      expect(resolveRunModule(command)).toBe('write-chapter')
      expect(isChapterWriteCommand(command)).toBe(false)
    }
  })
})
