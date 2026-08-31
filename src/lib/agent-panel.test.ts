import { describe, expect, test } from 'bun:test'
import { createEmptyAgentThread, reduceAgentEvent } from './agent-events'
import {
  AGENT_RUN_STALL_HINT_MS,
  formatAgentRunElapsed,
  getAgentPanelStatus,
  getAgentSteps,
  getPendingAgentQuestion,
  isAgentRunStalled,
  stripStepNumberPrefix,
} from './agent-panel'
import type { AgentEvent, AgentRun } from '@shared/types/agent'

const started: AgentEvent = {
  type: 'run.started',
  runId: 'run-1',
  threadId: 'thread-1',
  command: 'write-next',
  prompt: '继续写下一章',
  createdAt: '2026-04-27T00:00:00.000Z',
}

describe('isAgentRunStalled', () => {
  const baseRun: AgentRun = {
    id: 'run-1',
    threadId: 'thread-1',
    command: 'freeform',
    prompt: 'x',
    status: 'running',
    startedAt: '2026-04-27T00:00:00.000Z',
  }
  const at = (iso: string) => Date.parse(iso)

  test('not stalled while events keep arriving within the threshold', () => {
    const run: AgentRun = { ...baseRun, lastEventAt: '2026-04-27T00:00:00.000Z' }
    // 距上次事件 15 分钟 < 20 分钟阈值：热写/冷改单次长补全分钟级无事件属正常
    expect(isAgentRunStalled(run, at('2026-04-27T00:15:00.000Z'))).toBe(false)
  })

  test('stalled once no event arrives for the threshold while still running', () => {
    const run: AgentRun = { ...baseRun, lastEventAt: '2026-04-27T00:00:00.000Z' }
    expect(isAgentRunStalled(run, at('2026-04-27T00:20:00.000Z'))).toBe(true)
  })

  test('never stalled once the run has finished', () => {
    const run: AgentRun = { ...baseRun, status: 'failed', lastEventAt: '2026-04-27T00:00:00.000Z' }
    expect(isAgentRunStalled(run, at('2026-04-27T02:00:00.000Z'))).toBe(false)
  })

  test('falls back to startedAt before the first event', () => {
    expect(isAgentRunStalled(baseRun, at('2026-04-27T00:20:00.000Z'))).toBe(true)
  })

  test('returns false for no active run', () => {
    expect(isAgentRunStalled(null, at('2026-04-27T05:00:00.000Z'))).toBe(false)
  })

  test('运行时长格式化为 mm:ss，超一小时带小时位，负数归零', () => {
    expect(formatAgentRunElapsed(7_000)).toBe('00:07')
    expect(formatAgentRunElapsed(204_000)).toBe('03:24')
    expect(formatAgentRunElapsed(3_723_000)).toBe('1:02:03')
    expect(formatAgentRunElapsed(-5)).toBe('00:00')
    expect(formatAgentRunElapsed(Number.NaN)).toBe('00:00')
  })

  test('卡住提示阈值为 20 分钟', () => {
    expect(AGENT_RUN_STALL_HINT_MS).toBe(20 * 60_000)
  })
})

describe('agent panel helpers', () => {
  test('describes an idle thread as standby', () => {
    expect(getAgentPanelStatus(createEmptyAgentThread('thread-1'))).toEqual({
      label: '初始状态',
      stepCount: 0,
      tone: 'idle',
    })
  })

  test('describes a started run without steps as launching', () => {
    const thread = [started].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(getAgentPanelStatus(thread)).toEqual({
      label: 'Agent 启动中',
      stepCount: 0,
      tone: 'running',
    })
  })

  test('does not count assistant output, reasoning, or tool calls as task steps', () => {
    const thread = [
      started,
      {
        type: 'reasoning.delta',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        text: '先整理上下文。',
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
      {
        type: 'message.delta',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        text: '开始准备',
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'tool-1',
        toolName: 'NarraCat',
        title: '准备上下文包',
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(getAgentPanelStatus(thread)).toEqual({
      stepCount: 0,
      label: 'Agent 启动中',
      tone: 'running',
    })

    expect(getAgentSteps(thread)).toEqual([])
  })

  test('uses the current run task plan for top status and steps', () => {
    const thread = [
      started,
      {
        type: 'task-plan.updated',
        runId: 'run-1',
        items: [
          { id: 'task-1', title: '读取现有设定', status: 'complete' },
          { id: 'task-2', title: '生成风格指南', status: 'running' },
          { id: 'task-3', title: '刷新内容索引', status: 'pending' },
        ],
        createdAt: '2026-04-27T00:00:01.000Z',
      } as AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(getAgentPanelStatus(thread)).toEqual({
      currentStepIndex: 2,
      stepCount: 3,
      label: '生成风格指南',
      tone: 'running',
    })

    expect(getAgentSteps(thread)).toEqual([
      { id: 'task-1', title: '读取现有设定', detail: '完成', status: 'complete' },
      { id: 'task-2', title: '生成风格指南', detail: '进行中', status: 'running' },
      { id: 'task-3', title: '刷新内容索引', detail: '等待', status: 'pending' },
    ])
  })

  test('does not reuse historical task plans for a later run without a plan', () => {
    const thread = [
      started,
      {
        type: 'task-plan.updated',
        runId: 'run-1',
        items: [
          { id: 'task-1', title: '读取现有设定', status: 'complete' },
          { id: 'task-2', title: '生成风格指南', status: 'complete' },
        ],
        createdAt: '2026-04-27T00:00:01.000Z',
      } as AgentEvent,
      {
        type: 'run.completed',
        runId: 'run-1',
        createdAt: '2026-04-27T00:00:02.000Z',
      } satisfies AgentEvent,
      {
        type: 'run.started',
        runId: 'run-2',
        threadId: 'thread-1',
        command: 'freeform',
        prompt: '普通对话',
        createdAt: '2026-04-27T00:00:03.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(getAgentPanelStatus(thread)).toEqual({
      stepCount: 0,
      label: 'Agent 启动中',
      tone: 'running',
    })
    expect(getAgentSteps(thread)).toEqual([])
  })

  test('renders author-facing plan step names from structured progress events verbatim', () => {
    const thread = [
      started,
      {
        type: 'task-plan.updated',
        runId: 'run-1',
        items: [
          { id: 'task-1', title: '规划全书结构', status: 'complete' },
          { id: 'task-2', title: '细化章纲', status: 'running' },
          { id: 'task-3', title: '完成', status: 'pending' },
        ],
        createdAt: '2026-04-27T00:00:01.000Z',
      } as AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(getAgentSteps(thread)).toEqual([
      { id: 'task-1', title: '规划全书结构', detail: '完成', status: 'complete' },
      { id: 'task-2', title: '细化章纲', detail: '进行中', status: 'running' },
      { id: 'task-3', title: '完成', detail: '等待', status: 'pending' },
    ])
  })

  test('strips engine step-number prefixes from task plan titles', () => {
    const thread = [
      started,
      {
        type: 'task-plan.updated',
        runId: 'run-1',
        items: [
          { id: 'task-1', title: '步骤 0：前置检查（角色设定）', status: 'complete' },
          { id: 'task-2', title: '步骤 1.7.3：Path 2 第一轮 — outline-architect 推演 narrator_voice', status: 'running' },
        ],
        createdAt: '2026-04-27T00:00:01.000Z',
      } as AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(getAgentSteps(thread)).toEqual([
      { id: 'task-1', title: '前置检查（角色设定）', detail: '完成', status: 'complete' },
      {
        id: 'task-2',
        title: 'Path 2 第一轮 — outline-architect 推演 narrator_voice',
        detail: '进行中',
        status: 'running',
      },
    ])
  })
})

describe('stripStepNumberPrefix', () => {
  test('剥离整数步骤前缀', () => {
    expect(stripStepNumberPrefix('步骤 0：前置检查（角色设定）')).toBe('前置检查（角色设定）')
  })

  test('剥离多级小数步骤前缀，保留标题中的破折号', () => {
    expect(stripStepNumberPrefix('步骤 1.7.3：Path 2 第一轮 — outline-architect 推演 narrator_voice')).toBe(
      'Path 2 第一轮 — outline-architect 推演 narrator_voice',
    )
  })

  test('剥离后为空则保留原文', () => {
    expect(stripStepNumberPrefix('步骤 6')).toBe('步骤 6')
  })

  test('非步骤前缀的标题保持不变', () => {
    expect(stripStepNumberPrefix('读取现有设定')).toBe('读取现有设定')
  })
})


describe('getPendingAgentQuestion', () => {
  const asked: AgentEvent = {
    type: 'question.requested',
    runId: 'run-1',
    messageId: 'assistant-run-1',
    questionRequestId: 'question-1',
    toolCallId: 'tool-1',
    questions: [
      {
        question: '这本书用第几人称讲？',
        header: '叙述人称',
        options: [
          { label: '第一人称', description: '主角自述' },
          { label: '第三人称·跟随主角', description: '贴着主角写' },
        ],
      },
    ],
    createdAt: '2026-04-27T00:01:00.000Z',
  }

  function threadAfter(events: AgentEvent[]) {
    return events.reduce((thread, event) => reduceAgentEvent(thread, event), createEmptyAgentThread('thread-1'))
  }

  test('points at the question the author still owes an answer', () => {
    expect(getPendingAgentQuestion(threadAfter([started, asked]))).toEqual({
      questionRequestId: 'question-1',
      prompt: '这本书用第几人称讲？',
    })
  })

  test('goes quiet once the question is answered and the run resumes', () => {
    const answered: AgentEvent = {
      type: 'question.answered',
      runId: 'run-1',
      questionRequestId: 'question-1',
      answers: { 叙述人称: '第一人称' },
      createdAt: '2026-04-27T00:02:00.000Z',
    }

    expect(getPendingAgentQuestion(threadAfter([started, asked, answered]))).toBeNull()
  })

  test('goes quiet while the Agent is merely running', () => {
    expect(getPendingAgentQuestion(threadAfter([started]))).toBeNull()
  })
})
