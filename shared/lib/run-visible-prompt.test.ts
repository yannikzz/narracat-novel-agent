import { describe, expect, test } from 'bun:test'
import { resolveRunVisiblePrompt } from './run-visible-prompt'
import type { AgentEvent } from '@shared/types/agent'

type RunStarted = Extract<AgentEvent, { type: 'run.started' }>

function runStarted(overrides: Partial<RunStarted>): RunStarted {
  return {
    type: 'run.started',
    runId: 'run-1',
    threadId: 'thread-1',
    command: 'write-next',
    prompt: '',
    createdAt: '2026-04-27T00:00:00.000Z',
    ...overrides,
  } as RunStarted
}

describe('resolveRunVisiblePrompt', () => {
  test('prefers the explicit display prompt', () => {
    expect(resolveRunVisiblePrompt(runStarted({ prompt: '写本章', displayPrompt: '写第 12 章' }))).toBe('写第 12 章')
  })

  // 作者没补充要求时 prompt 是空的；气泡不能因此空掉（实时对话与重开后的历史都不行）
  test('names the chapter when the author added nothing to say', () => {
    expect(resolveRunVisiblePrompt(runStarted({ command: 'write-next', prompt: '', selectedChapter: 29 }))).toBe(
      '写第 29 章',
    )
    expect(resolveRunVisiblePrompt(runStarted({ command: 'recover-write', prompt: '', selectedChapter: 29 }))).toBe(
      '继续完成第 29 章',
    )
    expect(resolveRunVisiblePrompt(runStarted({ command: 'write-next', prompt: '' }))).toBe('写本章')
  })

  test('keeps what the author actually typed', () => {
    expect(resolveRunVisiblePrompt(runStarted({ prompt: '这一章节奏快一点', selectedChapter: 29 }))).toBe(
      '这一章节奏快一点',
    )
  })

  test('turns a bare chapter argument into words for review and rewrite', () => {
    expect(resolveRunVisiblePrompt(runStarted({ command: 'review', prompt: '42', selectedChapter: 42 }))).toBe(
      '审修第 42 章',
    )
    expect(resolveRunVisiblePrompt(runStarted({ command: 'rewrite', prompt: '42', selectedChapter: 42 }))).toBe(
      '重写第 42 章',
    )
  })
})
