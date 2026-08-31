import type {
  AgentEvent,
  AgentMessage,
  AgentMessagePart,
  AgentPartStatus,
  AgentQuestion,
  AgentRun,
  AgentSubToolCall,
  AgentThread,
  AgentTokenUsage,
} from '@shared/types/agent'
import { resolveRunVisiblePrompt } from '@shared/lib/run-visible-prompt'

export function createEmptyAgentThread(id: string): AgentThread {
  return {
    id,
    messages: [],
    activeRun: null,
    lastRun: null,
  }
}

export function reduceAgentEvent(thread: AgentThread, event: AgentEvent): AgentThread {
  const next = reduceAgentEventInner(thread, event)
  // 运行中刷新「最后事件时间」，供 UI 据「now - lastEventAt 超阈」判定长时间无响应（卡住提示）。
  // 终态事件经 finishRun 已把 activeRun 置空，故只在运行中记录。
  if (next.activeRun && next.activeRun.lastEventAt !== event.createdAt) {
    return { ...next, activeRun: { ...next.activeRun, lastEventAt: event.createdAt } }
  }
  return next
}

function reduceAgentEventInner(thread: AgentThread, event: AgentEvent): AgentThread {
  switch (event.type) {
    case 'run.started':
      return startRun(thread, event)
    case 'run.running':
      return updateActiveRunStatus(thread, event.runId, 'running')
    case 'run.cancelling':
      return updateActiveRunStatus(thread, event.runId, 'cancelling')
    case 'run.stalled':
      return updateActiveRunStalledAt(thread, event.runId, event.createdAt)
    case 'run.durability-failed':
      return updateActiveRunDurabilityFailed(thread, event.runId)
    case 'message.delta':
      return updateMessage(thread, event.messageId, (message) => appendTextDelta(completeRunningReasoning(message), event.text))
    case 'reasoning.delta':
      return updateMessage(thread, event.messageId, (message) => appendReasoningDelta(message, event.text))
    case 'tool.started':
      return updateMessage(thread, event.messageId, (message) => appendToolStart(completeRunningReasoning(message), event))
    case 'tool.completed':
      return updateToolPart(thread, event.toolCallId, createToolCompletionPatch(event))
    case 'tool.failed':
      return updateToolOrQuestionPart(thread, event.toolCallId, { status: 'failed', error: event.error })
    case 'question.requested':
      return updateActiveRunStatus(
        updateMessage(thread, event.messageId, (message) =>
          upsertQuestionPart(completeRunningReasoning(message), event.questionRequestId, event.toolCallId, event.questions),
        ),
        event.runId,
        'waiting-user',
      )
    case 'question.answered':
      return updateActiveRunStatus(
        updateQuestionPart(thread, event.questionRequestId, { status: 'complete', answers: event.answers }),
        event.runId,
        'running',
      )
    case 'task-plan.updated':
      return updateActiveRunTaskPlan(thread, event)
    case 'run.completed':
      return finishRun(thread, event.runId, 'complete', event.createdAt, event.usage)
    case 'run.failed':
      if (event.reason === 'model-service-required') {
        return appendModelServiceRequired(finishRun(thread, event.runId, 'failed', event.createdAt), event)
      }
      return appendRunError(finishRun(thread, event.runId, 'failed', event.createdAt), event.error)
    case 'run.cancelled':
      return finishRun(thread, event.runId, 'cancelled', event.createdAt)
    case 'run.interrupted':
      return appendRunError(
        finishRun(thread, event.runId, 'interrupted', event.createdAt),
        event.error,
        'interrupted',
      )
    case 'novel.project.updated':
      return thread
  }
}

function updateActiveRunStatus(
  thread: AgentThread,
  runId: string,
  status: Extract<AgentRun['status'], 'running' | 'waiting-user' | 'cancelling'>,
): AgentThread {
  if (thread.activeRun?.id !== runId) return thread
  return { ...thread, activeRun: { ...thread.activeRun, status } }
}

function updateActiveRunStalledAt(thread: AgentThread, runId: string, stalledAt: string): AgentThread {
  if (thread.activeRun?.id !== runId) return thread
  return { ...thread, activeRun: { ...thread.activeRun, stalledAt } }
}

function updateActiveRunDurabilityFailed(thread: AgentThread, runId: string): AgentThread {
  if (thread.activeRun?.id !== runId) return thread
  return { ...thread, activeRun: { ...thread.activeRun, status: 'durability-failed' } }
}

type RunStartedEvent = Extract<AgentEvent, { type: 'run.started' }>
type RunFailedEvent = Extract<AgentEvent, { type: 'run.failed' }>
type TaskPlanUpdatedEvent = Extract<AgentEvent, { type: 'task-plan.updated' }>
type ToolStartedEvent = Extract<AgentEvent, { type: 'tool.started' }>
type ToolCompletedEvent = Extract<AgentEvent, { type: 'tool.completed' }>
type MessageStatus = AgentMessage['status']
type ToolPatch = Partial<Extract<AgentMessagePart, { type: 'tool-call' }>>
type QuestionPatch = Partial<Extract<AgentMessagePart, { type: 'question' }>>

function createToolCompletionPatch(event: ToolCompletedEvent): ToolPatch {
  const patch: ToolPatch = { status: 'complete' }
  if (event.summary !== undefined) patch.summary = event.summary
  if (event.result !== undefined) patch.result = event.result
  return patch
}

function startRun(thread: AgentThread, event: RunStartedEvent): AgentThread {
  const visiblePrompt = resolveRunVisiblePrompt(event)
  const userMessage: AgentMessage = {
    id: `user-${event.runId}`,
    role: 'user',
    createdAt: event.createdAt,
    status: 'complete',
    parts: [
      {
        id: `part-user-${event.runId}-text`,
        type: 'text',
        text: visiblePrompt,
        status: 'complete',
      },
    ],
    // freeform 自由输入不挂指令标签；其余指令在气泡前渲染中文 chip（用户可见性）。
    ...(event.command !== 'freeform' ? { command: event.command } : {}),
    ...(event.origin ? { origin: event.origin } : {}),
  }

  const assistantMessage: AgentMessage = {
    id: `assistant-${event.runId}`,
    role: 'assistant',
    createdAt: event.createdAt,
    status: 'running',
    parts: [],
  }

  return {
    ...thread,
    id: event.threadId,
    messages: [...thread.messages, userMessage, assistantMessage],
    activeRun: {
      id: event.runId,
      threadId: event.threadId,
      command: event.command,
      prompt: event.prompt,
      status: 'accepted',
      startedAt: event.createdAt,
      projectPath: event.projectPath,
      selectedChapter: event.selectedChapter,
      target: event.target,
    },
  }
}

function appendTextDelta(message: AgentMessage, text: string): AgentMessage {
  const lastPartIndex = message.parts.length - 1
  const lastPart = message.parts[lastPartIndex]

  if (lastPart?.type !== 'text') {
    return {
      ...message,
      parts: [
        ...message.parts,
        {
          id: createSequentialPartId(message, 'text'),
          type: 'text',
          text,
          status: 'running',
        },
      ],
    }
  }

  return {
    ...message,
    parts: message.parts.map((part, index) => {
      if (index !== lastPartIndex || part.type !== 'text') return part
      return {
        ...part,
        text: `${part.text}${text}`,
        status: 'running',
      }
    }),
  }
}

function completeRunningReasoning(message: AgentMessage): AgentMessage {
  let changed = false
  const parts = message.parts.map((part) => {
    if (part.type !== 'reasoning' || part.status !== 'running') return part
    changed = true
    return { ...part, status: 'complete' as const }
  })

  return changed ? { ...message, parts } : message
}

function appendReasoningDelta(message: AgentMessage, text: string): AgentMessage {
  const lastPartIndex = message.parts.length - 1
  const lastPart = message.parts[lastPartIndex]

  if (lastPart?.type !== 'reasoning') {
    return {
      ...message,
      parts: [
        ...message.parts,
        {
          id: createSequentialPartId(message, 'reasoning'),
          type: 'reasoning',
          text,
          status: 'running',
        },
      ],
    }
  }

  return {
    ...message,
    parts: message.parts.map((part, index) => {
      if (index !== lastPartIndex || part.type !== 'reasoning') return part
      return {
        ...part,
        text: `${part.text}${text}`,
        status: 'running',
      }
    }),
  }
}

function createSequentialPartId(message: AgentMessage, type: 'text' | 'reasoning'): string {
  const baseId = `part-${message.id}-${type}`
  const existingCount = message.parts.filter((part) => part.type === type).length
  return existingCount === 0 ? baseId : `${baseId}-${existingCount + 1}`
}

function appendToolStart(message: AgentMessage, event: ToolStartedEvent): AgentMessage {
  if (event.toolName === 'AskUserQuestion') {
    const questions = normalizeAgentQuestions(event.input)
    if (questions.length > 0) {
      return upsertQuestionPart(message, event.toolCallId, event.toolCallId, questions)
    }
  }

  // 子 agent 归属：命中父 Task/Agent part 时折进其 children，不新建平铺 part；
  // 找不到父 part（旧事件流/父先于子丢失）时回落既有平铺逻辑，容错优先。
  if (event.parentToolCallId) {
    const withChild = attachSubToolCall(message, event.parentToolCallId, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      title: event.title,
      status: 'running',
      input: event.input,
    })
    if (withChild) return withChild
  }

  const existingPart = message.parts.find((part) => part.type === 'tool-call' && part.toolCallId === event.toolCallId)

  if (existingPart) {
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (part.type !== 'tool-call' || part.toolCallId !== event.toolCallId) return part
        return {
          ...part,
          toolName: event.toolName,
          title: event.title,
          input: event.input ?? part.input,
          status: 'running',
        }
      }),
    }
  }

  return {
    ...message,
    parts: [
      ...message.parts,
      {
        id: `part-${event.toolCallId}`,
        type: 'tool-call',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        title: event.title,
        input: event.input,
        status: 'running',
      },
    ],
  }
}

/** 命中 parentToolCallId 对应的 Task/Agent part 时，把子工具动作不可变地追加/替换进 children；未命中返回 null（调用方回落平铺渲染）。 */
function attachSubToolCall(message: AgentMessage, parentToolCallId: string, child: AgentSubToolCall): AgentMessage | null {
  const parentIndex = message.parts.findIndex((part) => part.type === 'tool-call' && part.toolCallId === parentToolCallId)
  if (parentIndex === -1) return null

  const parentPart = message.parts[parentIndex] as Extract<AgentMessagePart, { type: 'tool-call' }>
  const existingChildren = parentPart.children ?? []
  const existingChildIndex = existingChildren.findIndex((item) => item.toolCallId === child.toolCallId)
  const children =
    existingChildIndex === -1
      ? [...existingChildren, child]
      : existingChildren.map((item, index) => (index === existingChildIndex ? child : item))

  const parts = [...message.parts]
  parts[parentIndex] = { ...parentPart, children }
  return { ...message, parts }
}

function upsertQuestionPart(
  message: AgentMessage,
  questionRequestId: string,
  toolCallId: string,
  questions: AgentQuestion[]
): AgentMessage {
  const existingPart = message.parts.find(
    (part) => part.type === 'question' && part.questionRequestId === questionRequestId
  )

  if (existingPart) {
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (part.type !== 'question' || part.questionRequestId !== questionRequestId) return part
        return {
          ...part,
          toolCallId,
          questions,
          status: part.status === 'complete' ? part.status : 'running',
        }
      }),
    }
  }

  return {
    ...message,
    parts: [
      ...message.parts,
      {
        id: `part-${toolCallId}`,
        type: 'question',
        questionRequestId,
        toolCallId,
        questions,
        status: 'running',
      },
    ],
  }
}

function normalizeAgentQuestions(input: unknown): AgentQuestion[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const questions = (input as Record<string, unknown>).questions
  if (!Array.isArray(questions)) return []

  return questions.flatMap((question): AgentQuestion[] => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) return []
    const record = question as Record<string, unknown>
    const questionText = typeof record.question === 'string' ? record.question : ''
    const header = typeof record.header === 'string' ? record.header : ''
    const options = Array.isArray(record.options) ? record.options : []
    if (!questionText.trim() || !header.trim() || options.length < 2) return []

    const normalizedOptions = options.flatMap((option) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return []
      const optionRecord = option as Record<string, unknown>
      const label = typeof optionRecord.label === 'string' ? optionRecord.label : ''
      const description = typeof optionRecord.description === 'string' ? optionRecord.description : ''
      const preview = typeof optionRecord.preview === 'string' ? optionRecord.preview : undefined
      if (!label.trim()) return []
      return [{ label, description, ...(preview !== undefined ? { preview } : {}) }]
    })
    if (normalizedOptions.length < 2) return []

    return [
      {
        question: questionText,
        header,
        options: normalizedOptions,
        ...(record.multiSelect === true ? { multiSelect: true } : {}),
      },
    ]
  })
}

function updateMessage(
  thread: AgentThread,
  messageId: string,
  updater: (message: AgentMessage) => AgentMessage
): AgentThread {
  return {
    ...thread,
    messages: thread.messages.map((message) => (message.id === messageId ? updater(message) : message)),
  }
}

function updateMessageParts(
  thread: AgentThread,
  updater: (part: AgentMessagePart) => AgentMessagePart,
): AgentThread {
  let changed = false
  const messages = thread.messages.map((message) => {
    let nextParts: AgentMessagePart[] | null = null

    message.parts.forEach((part, index) => {
      const nextPart = updater(part)
      if (nextPart === part) return

      nextParts ??= [...message.parts]
      nextParts[index] = nextPart
      changed = true
    })

    return nextParts ? { ...message, parts: nextParts } : message
  })

  return changed ? { ...thread, messages } : thread
}

function updateToolPart(thread: AgentThread, toolCallId: string, patch: ToolPatch): AgentThread {
  return updateMessageParts(thread, (part) => {
    if (part.type !== 'tool-call') return part
    return patchToolCallOrChild(part, toolCallId, patch)
  })
}

/** 先按顶层 toolCallId 命中；未命中时扫该 part 的 children，命中则只替换子项的 status/error（children 无 summary/result 字段）。 */
function patchToolCallOrChild(
  part: Extract<AgentMessagePart, { type: 'tool-call' }>,
  toolCallId: string,
  patch: ToolPatch,
): AgentMessagePart {
  if (part.toolCallId === toolCallId) {
    return { ...part, ...patch }
  }

  const childIndex = part.children?.findIndex((child) => child.toolCallId === toolCallId) ?? -1
  if (childIndex === -1 || !part.children) return part

  const children = [...part.children]
  children[childIndex] = {
    ...children[childIndex],
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
  }
  return { ...part, children }
}

function updateQuestionPart(thread: AgentThread, questionRequestId: string, patch: QuestionPatch): AgentThread {
  return updateMessageParts(thread, (part) => {
    if (part.type !== 'question' || part.questionRequestId !== questionRequestId) return part
    return {
      ...part,
      ...patch,
    }
  })
}

function updateToolOrQuestionPart(thread: AgentThread, toolCallId: string, patch: ToolPatch & QuestionPatch): AgentThread {
  return updateMessageParts(thread, (part) => {
    if (part.type === 'tool-call') {
      return patchToolCallOrChild(part, toolCallId, patch)
    }

    if (part.type === 'question' && part.toolCallId === toolCallId) {
      return {
        ...part,
        ...patch,
      }
    }

    return part
  })
}

function updateActiveRunTaskPlan(thread: AgentThread, event: TaskPlanUpdatedEvent): AgentThread {
  if (thread.activeRun?.id !== event.runId) return thread

  return {
    ...thread,
    activeRun: {
      ...thread.activeRun,
      taskPlan: {
        runId: event.runId,
        items: event.items,
        updatedAt: event.createdAt,
      },
    },
  }
}

function finishRun(
  thread: AgentThread,
  runId: string,
  status: Extract<MessageStatus, 'complete' | 'failed' | 'cancelled' | 'interrupted'>,
  createdAt: string,
  usage?: AgentTokenUsage
): AgentThread {
  const assistantMessageId = `assistant-${runId}`
  const nextLastRun =
    thread.activeRun?.id === runId
      ? {
          ...thread.activeRun,
          status,
          finishedAt: createdAt,
        }
      : thread.lastRun

  return {
    ...thread,
    activeRun: thread.activeRun?.id === runId ? null : thread.activeRun,
    lastRun: nextLastRun,
    messages: thread.messages.map((message) => {
      if (message.id !== assistantMessageId) return message

      return {
        ...message,
        status,
        usage,
        parts: message.parts.map((part) => {
          if (part.status === 'running') {
            return completeRunningPart(part, status)
          }

          return part
        }),
      }
    }),
  }
}

function completeRunningPart(
  part: AgentMessagePart,
  status: Extract<MessageStatus, 'complete' | 'failed' | 'cancelled' | 'interrupted'>
): AgentMessagePart {
  switch (part.type) {
    case 'error':
      return part
    case 'tool-call': {
      const finalStatus: AgentPartStatus = status === 'failed' || status === 'interrupted' ? 'failed' : 'complete'
      // 子 agent 分组卡：父 part 收尾时一并收尾仍 running 的 children，避免展开卡里永久转圈。
      const children: AgentSubToolCall[] | undefined = part.children?.map((child): AgentSubToolCall =>
        child.status === 'running' ? { ...child, status: finalStatus } : child,
      )
      return { ...part, status: finalStatus, ...(children ? { children } : {}) }
    }
    case 'question':
      return { ...part, status: status === 'failed' || status === 'interrupted' ? 'failed' : 'complete' }
    case 'text':
    case 'reasoning':
    case 'data':
      return { ...part, status: 'complete' }
    case 'model-service-required':
      return part
  }
}

function appendModelServiceRequired(thread: AgentThread, event: RunFailedEvent): AgentThread {
  const lastAssistantMessage = [...thread.messages].reverse().find((message) => message.role === 'assistant')
  if (!lastAssistantMessage) return thread

  return updateMessage(thread, lastAssistantMessage.id, (message) => ({
    ...message,
    parts: [
      ...message.parts,
      {
        id: `part-${message.id}-model-service-required`,
        type: 'model-service-required',
        provider: event.provider ?? 'deepseek',
        title: '先接通模型服务',
        detail: '完成“测试连接”后，Agent 才会开始执行创作任务。',
        status: 'failed',
      },
    ],
  }))
}

function appendRunError(
  thread: AgentThread,
  error: string,
  tone: 'failed' | 'interrupted' = 'failed',
): AgentThread {
  const lastAssistantMessage = [...thread.messages].reverse().find((message) => message.role === 'assistant')
  if (!lastAssistantMessage) return thread

  return updateMessage(thread, lastAssistantMessage.id, (message) => ({
    ...message,
    parts: [
      ...message.parts,
      {
        id: `part-${message.id}-error`,
        type: 'error',
        tone,
        title: tone === 'interrupted' ? '任务已中断' : '运行失败',
        detail: error,
        status: 'failed',
      },
    ],
  }))
}
