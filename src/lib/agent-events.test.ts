import { describe, expect, test } from 'bun:test'
import { createEmptyAgentThread, reduceAgentEvent } from './agent-events'
import type { AgentEvent } from '../types/agent'

const started: AgentEvent = {
  type: 'run.started',
  runId: 'run-1',
  threadId: 'thread-1',
  command: 'write-next',
  prompt: '写下一章',
  createdAt: '2026-04-27T00:00:00.000Z',
}

describe('reduceAgentEvent', () => {
  test('records the last event time on the active run for stall detection', () => {
    let thread = reduceAgentEvent(createEmptyAgentThread('thread-1'), started)
    expect(thread.activeRun?.lastEventAt).toBe('2026-04-27T00:00:00.000Z')

    thread = reduceAgentEvent(thread, {
      type: 'message.delta',
      runId: 'run-1',
      messageId: 'assistant-run-1',
      text: '继续写',
      createdAt: '2026-04-27T00:05:00.000Z',
    })
    expect(thread.activeRun?.lastEventAt).toBe('2026-04-27T00:05:00.000Z')
  })

  test('starts a run with a user task and running assistant message', () => {
    const thread = reduceAgentEvent(createEmptyAgentThread('thread-1'), started)

    expect(thread.activeRun?.id).toBe('run-1')
    expect(thread.messages).toHaveLength(2)
    expect(thread.messages[0]?.role).toBe('user')
    expect(thread.messages[1]?.role).toBe('assistant')
    expect(thread.messages[1]?.status).toBe('running')
    expect(thread.activeRun?.status).toBe('accepted')
    expect(
      reduceAgentEvent(thread, {
        type: 'run.running',
        runId: 'run-1',
        createdAt: '2026-04-27T00:00:01.000Z',
      }).activeRun?.status,
    ).toBe('running')
  })

  test('shows a readable chapter review task instead of the raw numeric command argument', () => {
    const thread = reduceAgentEvent(createEmptyAgentThread('thread-1'), {
      type: 'run.started',
      runId: 'run-review-1',
      threadId: 'thread-1',
      command: 'review',
      prompt: '1',
      selectedChapter: 1,
      createdAt: '2026-04-27T00:00:00.000Z',
    })

    expect(thread.messages[0]?.parts).toContainEqual(
      expect.objectContaining({
        type: 'text',
        text: '审修第 1 章',
      }),
    )
    expect(thread.activeRun?.prompt).toBe('1')
  })

  test('shows the clean displayPrompt in the bubble while keeping the targeting prompt for the agent', () => {
    const thread = reduceAgentEvent(createEmptyAgentThread('thread-1'), {
      type: 'run.started',
      runId: 'run-setup-1',
      threadId: 'thread-1',
      command: 'setup',
      prompt: '请为当前小说生成核心前提。\n\n目标：核心前提（sectionId: settings，tabId: bible-document，objectId: bible-document）。',
      displayPrompt: '生成核心前提',
      createdAt: '2026-04-27T00:00:00.000Z',
    })

    expect(thread.messages[0]?.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: '生成核心前提' }),
    )
    // 定位元信息不进气泡，但完整 prompt 仍发给 Agent。
    expect(thread.messages[0]?.parts[0]).not.toMatchObject({ text: expect.stringContaining('sectionId') })
    expect(thread.activeRun?.prompt).toContain('sectionId: settings')
  })

  test('tags the user message with its command, and leaves freeform messages untagged', () => {
    const setupThread = reduceAgentEvent(createEmptyAgentThread('thread-1'), {
      type: 'run.started',
      runId: 'run-setup-2',
      threadId: 'thread-1',
      command: 'setup',
      prompt: '生成核心前提',
      createdAt: '2026-04-27T00:00:00.000Z',
    })
    expect(setupThread.messages[0]?.command).toBe('setup')

    const freeformThread = reduceAgentEvent(createEmptyAgentThread('thread-2'), {
      type: 'run.started',
      runId: 'run-freeform-1',
      threadId: 'thread-2',
      command: 'freeform',
      prompt: '帮我看看这一段',
      createdAt: '2026-04-27T00:00:00.000Z',
    })
    expect(freeformThread.messages[0]?.command).toBeUndefined()
  })

  test('run.started 带 origin=action 时 user 消息标记为动作发起（任务卡渲染依据）', () => {
    const thread = reduceAgentEvent(createEmptyAgentThread('t'), {
      type: 'run.started',
      runId: 'r1',
      threadId: 't',
      command: 'write-next',
      prompt: '写本章',
      displayPrompt: '写第 12 章',
      origin: 'action',
      createdAt: '2026-07-06T00:00:00.000Z',
    })
    const userMessage = thread.messages[0]
    expect(userMessage.origin).toBe('action')
    expect(userMessage.parts[0]).toMatchObject({ type: 'text', text: '写第 12 章' })
  })

  test('appends text deltas to the running assistant message', () => {
    const thread = [
      started,
      {
        type: 'message.delta',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        text: '正在准备上下文',
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
      {
        type: 'message.delta',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        text: '...',
        createdAt: '2026-04-27T00:00:02.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(thread.messages[1]?.parts).toContainEqual({
      id: 'part-assistant-run-1-text',
      type: 'text',
      text: '正在准备上下文...',
      status: 'running',
    })
  })

  test('appends reasoning deltas to the running assistant message', () => {
    const thread = [
      started,
      {
        type: 'reasoning.delta',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        text: '先判断用户想继续写作。',
        createdAt: '2026-04-27T00:00:01.000Z',
      },
      {
        type: 'reasoning.delta',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        text: '再组织下一章方向。',
        createdAt: '2026-04-27T00:00:02.000Z',
      },
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(thread.messages[1]?.parts).toContainEqual({
      id: 'part-assistant-run-1-reasoning',
      type: 'reasoning',
      text: '先判断用户想继续写作。再组织下一章方向。',
      status: 'running',
    })
  })

  test('marks reasoning complete when assistant text starts after thinking', () => {
    const thread = [
      started,
      {
        type: 'reasoning.delta',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        text: '先检查插件目录。',
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
      {
        type: 'message.delta',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        text: '我找到了 NarraCat 插件。',
        createdAt: '2026-04-27T00:00:02.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(thread.messages[1]?.parts).toMatchObject([
      { type: 'reasoning', text: '先检查插件目录。', status: 'complete' },
      { type: 'text', text: '我找到了 NarraCat 插件。', status: 'running' },
    ])
  })

  test('marks reasoning complete when a tool starts after thinking', () => {
    const thread = [
      started,
      {
        type: 'reasoning.delta',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        text: '需要读取目录。',
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'tool-1',
        toolName: 'Bash',
        title: '执行命令',
        input: { command: 'ls -la /workspace/NarraCat' },
        createdAt: '2026-04-27T00:00:02.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(thread.messages[1]?.parts).toMatchObject([
      { type: 'reasoning', text: '需要读取目录。', status: 'complete' },
      { type: 'tool-call', toolName: 'Bash', status: 'running' },
    ])
  })

  test('updates one tool-call part through start and completion', () => {
    const thread = [
      started,
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'tool-1',
        toolName: 'Write',
        title: '写入章节草稿',
        input: { file_path: 'manuscript/ch042.md', content: '正文' },
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
      {
        type: 'tool.completed',
        runId: 'run-1',
        toolCallId: 'tool-1',
        summary: 'manuscript/ch042.md',
        result: '写入完成',
        createdAt: '2026-04-27T00:00:02.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    const toolPart = thread.messages[1]?.parts.find((part) => part.type === 'tool-call')
    expect(toolPart).toMatchObject({
      type: 'tool-call',
      toolCallId: 'tool-1',
      toolName: 'Write',
      status: 'complete',
      summary: 'manuscript/ch042.md',
      result: '写入完成',
      input: { file_path: 'manuscript/ch042.md', content: '正文' },
    })
  })

  test('preserves unchanged message references when a tool part updates', () => {
    const runningThread = [
      started,
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'tool-1',
        toolName: 'Read',
        title: '读取章节',
        input: { file_path: 'chapter.md' },
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))
    const userMessage = runningThread.messages[0]
    const assistantMessage = runningThread.messages[1]

    const updatedThread = reduceAgentEvent(runningThread, {
      type: 'tool.completed',
      runId: 'run-1',
      toolCallId: 'tool-1',
      summary: '读取完成',
      createdAt: '2026-04-27T00:00:02.000Z',
    })

    expect(updatedThread.messages[0]).toBe(userMessage)
    expect(updatedThread.messages[1]).not.toBe(assistantMessage)
  })

  test('renders AskUserQuestion tool starts as interactive question parts', () => {
    const thread = [
      started,
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'tool-question-1',
        toolName: 'AskUserQuestion',
        title: '调用 AskUserQuestion',
        input: {
          questions: [
            {
              header: '概念',
              question: '这个故事关于什么？',
              options: [
                { label: '小人物', description: '从个体命运切入' },
                { label: '群像', description: '从群体关系切入' },
              ],
            },
          ],
        },
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(thread.messages[1]?.parts).toContainEqual({
      id: 'part-tool-question-1',
      type: 'question',
      questionRequestId: 'tool-question-1',
      toolCallId: 'tool-question-1',
      questions: [
        {
          header: '概念',
          question: '这个故事关于什么？',
          options: [
            { label: '小人物', description: '从个体命运切入' },
            { label: '群像', description: '从群体关系切入' },
          ],
        },
      ],
      status: 'running',
    })
  })

  test('marks interactive questions complete when the user answers', () => {
    const thread = [
      started,
      {
        type: 'question.requested',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        questionRequestId: 'tool-question-1',
        toolCallId: 'tool-question-1',
        questions: [
          {
            header: '概念',
            question: '这个故事关于什么？',
            options: [
              { label: '小人物', description: '从个体命运切入' },
              { label: '群像', description: '从群体关系切入' },
            ],
          },
        ],
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
      {
        type: 'question.answered',
        runId: 'run-1',
        questionRequestId: 'tool-question-1',
        answers: { '这个故事关于什么？': '小人物' },
        createdAt: '2026-04-27T00:00:02.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(thread.messages[1]?.parts.find((part) => part.type === 'question')).toMatchObject({
      type: 'question',
      questionRequestId: 'tool-question-1',
      status: 'complete',
      answers: { '这个故事关于什么？': '小人物' },
    })
  })

  test('preserves unchanged message references when a question part updates', () => {
    const waitingThread = [
      started,
      {
        type: 'question.requested',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        questionRequestId: 'tool-question-1',
        toolCallId: 'tool-question-1',
        questions: [
          {
            header: '概念',
            question: '这个故事关于什么？',
            options: [
              { label: '小人物', description: '从个体命运切入' },
              { label: '群像', description: '从群体关系切入' },
            ],
          },
        ],
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))
    const userMessage = waitingThread.messages[0]
    const assistantMessage = waitingThread.messages[1]

    const answeredThread = reduceAgentEvent(waitingThread, {
      type: 'question.answered',
      runId: 'run-1',
      questionRequestId: 'tool-question-1',
      answers: { '这个故事关于什么？': '小人物' },
      createdAt: '2026-04-27T00:00:02.000Z',
    })

    expect(answeredThread.messages[0]).toBe(userMessage)
    expect(answeredThread.messages[1]).not.toBe(assistantMessage)
  })

  test('marks unanswered interactive questions failed when the run fails', () => {
    const thread = [
      started,
      {
        type: 'question.requested',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        questionRequestId: 'tool-question-1',
        toolCallId: 'tool-question-1',
        questions: [
          {
            header: '概念',
            question: '这个故事关于什么？',
            options: [
              { label: '小人物', description: '从个体命运切入' },
              { label: '群像', description: '从群体关系切入' },
            ],
          },
        ],
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
      {
        type: 'run.failed',
        runId: 'run-1',
        error: '用户未回答',
        createdAt: '2026-04-27T00:00:02.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(thread.messages[1]?.parts.find((part) => part.type === 'question')).toMatchObject({
      type: 'question',
      questionRequestId: 'tool-question-1',
      status: 'failed',
    })
  })

  test('keeps repeated tool start events as one running tool row without clearing input', () => {
    const toolStarted = {
      type: 'tool.started',
      runId: 'run-1',
      messageId: 'assistant-run-1',
      toolCallId: 'tool-1',
      toolName: 'Read',
      title: '调用 Read',
      input: { file_path: 'chapter.md' },
      createdAt: '2026-04-27T00:00:01.000Z',
    } satisfies AgentEvent

    const repeatedWithoutInput = {
      ...toolStarted,
      input: undefined,
      createdAt: '2026-04-27T00:00:02.000Z',
    } satisfies AgentEvent

    const thread = [started, toolStarted, repeatedWithoutInput].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(thread.messages[1]?.parts.filter((part) => part.type === 'tool-call')).toHaveLength(1)
    expect(thread.messages[1]?.parts.find((part) => part.type === 'tool-call')).toMatchObject({
      input: { file_path: 'chapter.md' },
    })
  })

  test('adds tool summaries without clearing existing tool results', () => {
    const thread = [
      started,
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'tool-1',
        toolName: 'Read',
        title: '调用 Read',
        input: { file_path: 'chapter.md' },
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
      {
        type: 'tool.completed',
        runId: 'run-1',
        toolCallId: 'tool-1',
        result: '完整章节内容',
        createdAt: '2026-04-27T00:00:02.000Z',
      } satisfies AgentEvent,
      {
        type: 'tool.completed',
        runId: 'run-1',
        toolCallId: 'tool-1',
        summary: '读取 chapter.md',
        createdAt: '2026-04-27T00:00:03.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(thread.messages[1]?.parts.find((part) => part.type === 'tool-call')).toMatchObject({
      summary: '读取 chapter.md',
      result: '完整章节内容',
    })
  })

  test('preserves chronological part order when tools interleave with text', () => {
    const thread = [
      started,
      {
        type: 'message.delta',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        text: '我先看一下项目结构。',
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'tool-1',
        toolName: 'Bash',
        title: '执行命令',
        input: { command: 'ls -la /workspace/NarraCat' },
        createdAt: '2026-04-27T00:00:02.000Z',
      } satisfies AgentEvent,
      {
        type: 'tool.completed',
        runId: 'run-1',
        toolCallId: 'tool-1',
        summary: '列出目录',
        createdAt: '2026-04-27T00:00:03.000Z',
      } satisfies AgentEvent,
      {
        type: 'message.delta',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        text: '这个插件包含 commands、agents 和 skills。',
        createdAt: '2026-04-27T00:00:04.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(
      thread.messages[1]?.parts.map((part) => ({
        type: part.type,
        text: part.type === 'text' ? part.text : undefined,
        toolName: part.type === 'tool-call' ? part.toolName : undefined,
      }))
    ).toEqual([
      { type: 'text', text: '我先看一下项目结构。', toolName: undefined },
      { type: 'tool-call', text: undefined, toolName: 'Bash' },
      { type: 'text', text: '这个插件包含 commands、agents 和 skills。', toolName: undefined },
    ])
  })

  test('completion clears the active run and records usage', () => {
    const thread = [
      started,
      {
        type: 'run.completed',
        runId: 'run-1',
        usage: { inputTokens: 100, outputTokens: 50 },
        createdAt: '2026-04-27T00:00:03.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(thread.activeRun).toBeNull()
    expect(thread.messages[1]?.status).toBe('complete')
    expect(thread.messages[1]?.usage?.outputTokens).toBe(50)
  })

  test('retains completed write run metadata after active run clears', () => {
    const thread = [
      {
        type: 'run.started',
        runId: 'run-1',
        threadId: 'thread-1',
        command: 'write-next',
        prompt: '继续写下一章',
        projectPath: '/novels/stars',
        selectedChapter: 1,
        target: {
          sectionId: 'blueprint',
          tabId: 'master-outline',
          objectId: 'master-outline',
        },
        createdAt: '2026-05-03T00:00:00.000Z',
      } satisfies AgentEvent,
      {
        type: 'run.completed',
        runId: 'run-1',
        createdAt: '2026-05-03T00:01:00.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(thread.activeRun).toBeNull()
    expect(thread.lastRun).toMatchObject({
      id: 'run-1',
      command: 'write-next',
      status: 'complete',
      projectPath: '/novels/stars',
      selectedChapter: 1,
      target: {
        sectionId: 'blueprint',
        tabId: 'master-outline',
        objectId: 'master-outline',
      },
      finishedAt: '2026-05-03T00:01:00.000Z',
    })
  })

  test('retains failed run metadata for retry affordances', () => {
    const thread = [
      {
        type: 'run.started',
        runId: 'run-1',
        threadId: 'thread-1',
        command: 'write-next',
        prompt: '继续写下一章',
        projectPath: '/novels/stars',
        selectedChapter: 1,
        createdAt: '2026-05-03T00:00:00.000Z',
      } satisfies AgentEvent,
      {
        type: 'run.failed',
        runId: 'run-1',
        error: 'outline missing',
        createdAt: '2026-05-03T00:01:00.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(thread.activeRun).toBeNull()
    expect(thread.lastRun?.status).toBe('failed')
  })

  test('renders model service required failures as a dedicated assistant part', () => {
    const thread = [
      {
        type: 'run.started',
        runId: 'run-1',
        threadId: 'thread-1',
        command: 'write-next',
        prompt: '继续写下一章',
        createdAt: '2026-05-03T00:00:00.000Z',
      } satisfies AgentEvent,
      {
        type: 'run.failed',
        runId: 'run-1',
        reason: 'model-service-required',
        provider: 'deepseek',
        error: '模型服务尚未验证。',
        createdAt: '2026-05-03T00:01:00.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    const part = thread.messages[1]?.parts.at(-1)
    expect(part).toMatchObject({
      type: 'model-service-required',
      provider: 'deepseek',
      title: '先接通模型服务',
      status: 'failed',
    })
    expect(thread.activeRun).toBeNull()
    expect(thread.lastRun?.status).toBe('failed')
  })

  test('ignores project update events in the transcript reducer', () => {
    const thread = createEmptyAgentThread('thread-1')

    expect(
      reduceAgentEvent(thread, {
        type: 'novel.project.updated',
        runId: 'run-1',
        projectPath: '/novels/stars',
        selectedChapter: 1,
        createdAt: '2026-05-03T00:00:00.000Z',
      }),
    ).toBe(thread)
  })

  test('failure clears active run without marking streamed content as failed', () => {
    const thread = [
      started,
      {
        type: 'reasoning.delta',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        text: '先检查环境。',
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
      {
        type: 'message.delta',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        text: '正在准备上下文',
        createdAt: '2026-04-27T00:00:02.000Z',
      } satisfies AgentEvent,
      {
        type: 'run.failed',
        runId: 'run-1',
        error: '模型调用失败',
        createdAt: '2026-04-27T00:00:03.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    const reasoningPart = thread.messages[1]?.parts.find((part) => part.type === 'reasoning')
    const textPart = thread.messages[1]?.parts.find((part) => part.type === 'text')
    expect(thread.activeRun).toBeNull()
    expect(thread.messages[1]?.status).toBe('failed')
    expect(reasoningPart?.status).toBe('complete')
    expect(textPart?.status).toBe('complete')
  })

  test('labels an interrupted run separately from a real failure', () => {
    const thread = [
      started,
      {
        type: 'run.interrupted',
        runId: 'run-1',
        error: '上次关闭 App 时，这项任务还没有完成。已完成的内容仍然保留。',
        createdAt: '2026-04-27T00:00:03.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(thread.messages[1]?.parts.at(-1)).toMatchObject({
      type: 'error',
      tone: 'interrupted',
      title: '任务已中断',
    })
    expect(thread.lastRun?.status).toBe('interrupted')
  })

  test('cancellation clears active run without deleting messages', () => {
    const thread = [
      started,
      {
        type: 'run.cancelled',
        runId: 'run-1',
        createdAt: '2026-04-27T00:00:03.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    expect(thread.activeRun).toBeNull()
    expect(thread.messages).toHaveLength(2)
    expect(thread.messages[1]?.status).toBe('cancelled')
  })

  test('带 parentToolCallId 的 tool.started 折进父 Task part 的 children，不新建平铺 part', () => {
    const thread = [
      started,
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'task-1',
        toolName: 'Task',
        title: '派发子 agent',
        input: { subagent_type: 'narracat:chapter-writer' },
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'child-1',
        toolName: 'Write',
        title: '写入草稿',
        input: { file_path: 'manuscript/ch001.md' },
        parentToolCallId: 'task-1',
        createdAt: '2026-04-27T00:00:02.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    const parts = thread.messages[1]?.parts ?? []
    const taskPart = parts.find((part) => part.type === 'tool-call' && part.toolCallId === 'task-1')
    expect(parts.filter((part) => part.type === 'tool-call')).toHaveLength(1)
    expect(taskPart).toMatchObject({
      children: [
        {
          toolCallId: 'child-1',
          toolName: 'Write',
          title: '写入草稿',
          status: 'running',
          input: { file_path: 'manuscript/ch001.md' },
        },
      ],
    })
  })

  test('同一 child toolCallId 重复 tool.started 时整项替换而非追加', () => {
    const thread = [
      started,
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'task-1',
        toolName: 'Task',
        title: '派发子 agent',
        input: { subagent_type: 'narracat:chapter-writer' },
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'child-1',
        toolName: 'Read',
        title: '读取大纲',
        input: { file_path: 'outline.md' },
        parentToolCallId: 'task-1',
        createdAt: '2026-04-27T00:00:02.000Z',
      } satisfies AgentEvent,
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'child-1',
        toolName: 'Write',
        title: '写入草稿',
        input: { file_path: 'manuscript/ch001.md' },
        parentToolCallId: 'task-1',
        createdAt: '2026-04-27T00:00:03.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    const taskPart = thread.messages[1]?.parts.find((part) => part.type === 'tool-call' && part.toolCallId === 'task-1')
    expect(taskPart).toMatchObject({
      children: [{ toolCallId: 'child-1', toolName: 'Write', title: '写入草稿' }],
    })
    expect((taskPart as { children?: unknown[] })?.children).toHaveLength(1)
  })

  test('tool.completed/tool.failed 命中 children 内的 toolCallId 时更新子项状态', () => {
    const thread = [
      started,
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'task-1',
        toolName: 'Task',
        title: '派发子 agent',
        input: { subagent_type: 'narracat:chapter-writer' },
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'child-1',
        toolName: 'Write',
        title: '写入草稿',
        input: { file_path: 'manuscript/ch001.md' },
        parentToolCallId: 'task-1',
        createdAt: '2026-04-27T00:00:02.000Z',
      } satisfies AgentEvent,
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'child-2',
        toolName: 'Read',
        title: '读取大纲',
        parentToolCallId: 'task-1',
        createdAt: '2026-04-27T00:00:03.000Z',
      } satisfies AgentEvent,
      {
        type: 'tool.completed',
        runId: 'run-1',
        toolCallId: 'child-1',
        summary: '已写入',
        createdAt: '2026-04-27T00:00:04.000Z',
      } satisfies AgentEvent,
      {
        type: 'tool.failed',
        runId: 'run-1',
        toolCallId: 'child-2',
        error: '文件不存在',
        createdAt: '2026-04-27T00:00:05.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    const taskPart = thread.messages[1]?.parts.find((part) => part.type === 'tool-call' && part.toolCallId === 'task-1')
    expect(taskPart).toMatchObject({
      status: 'running',
      children: [
        { toolCallId: 'child-1', status: 'complete' },
        { toolCallId: 'child-2', status: 'failed', error: '文件不存在' },
      ],
    })
  })

  test('parentToolCallId 找不到父 part 时回落平铺渲染（容错旧事件流）', () => {
    const thread = [
      started,
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'child-orphan',
        toolName: 'Write',
        title: '写入草稿',
        parentToolCallId: 'missing-parent',
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    const parts = thread.messages[1]?.parts ?? []
    expect(parts.filter((part) => part.type === 'tool-call')).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      type: 'tool-call',
      toolCallId: 'child-orphan',
      status: 'running',
    })
    expect((parts[0] as { children?: unknown[] }).children).toBeUndefined()
  })

  test('run 终止时把仍 running 的 children 也一并收尾，避免展开卡里出现永久转圈', () => {
    const thread = [
      started,
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'task-1',
        toolName: 'Task',
        title: '派发子 agent',
        input: { subagent_type: 'narracat:chapter-writer' },
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'child-1',
        toolName: 'Write',
        title: '写入草稿',
        parentToolCallId: 'task-1',
        createdAt: '2026-04-27T00:00:02.000Z',
      } satisfies AgentEvent,
      {
        type: 'run.completed',
        runId: 'run-1',
        createdAt: '2026-04-27T00:00:03.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    const taskPart = thread.messages[1]?.parts.find((part) => part.type === 'tool-call' && part.toolCallId === 'task-1')
    expect(taskPart).toMatchObject({
      status: 'complete',
      children: [{ toolCallId: 'child-1', status: 'complete' }],
    })
  })

  test('cancellation clears active run and completes running text', () => {
    const thread = [
      started,
      {
        type: 'message.delta',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        text: '正在准备上下文',
        createdAt: '2026-04-27T00:00:01.000Z',
      } satisfies AgentEvent,
      {
        type: 'run.cancelled',
        runId: 'run-1',
        createdAt: '2026-04-27T00:00:03.000Z',
      } satisfies AgentEvent,
    ].reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    const textPart = thread.messages[1]?.parts.find((part) => part.type === 'text')
    expect(thread.activeRun).toBeNull()
    expect(thread.messages[1]?.status).toBe('cancelled')
    expect(textPart?.status).toBe('complete')
  })
})


describe('write-next 气泡文案', () => {
  // prompt 为空是正常态（作者没补充要求时，产品文案不当作者的话往下发），气泡不能因此空掉。
  test('shows a human label when the author added nothing to say', () => {
    const thread = reduceAgentEvent(createEmptyAgentThread('thread-1'), {
      type: 'run.started',
      runId: 'run-2',
      threadId: 'thread-1',
      command: 'write-next',
      prompt: '',
      selectedChapter: 29,
      createdAt: '2026-04-27T00:00:00.000Z',
    })

    expect(thread.messages[0].parts[0]).toMatchObject({ type: 'text', text: '写第 29 章' })
  })

  test('shows what the author typed when they did say something', () => {
    const thread = reduceAgentEvent(createEmptyAgentThread('thread-1'), {
      type: 'run.started',
      runId: 'run-3',
      threadId: 'thread-1',
      command: 'write-next',
      prompt: '这一章节奏快一点',
      selectedChapter: 29,
      createdAt: '2026-04-27T00:00:00.000Z',
    })

    expect(thread.messages[0].parts[0]).toMatchObject({ type: 'text', text: '这一章节奏快一点' })
  })
})
