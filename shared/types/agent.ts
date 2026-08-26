// 'action'：由工作台按钮（空页 CTA/状态页/评估 dock 等）发起的运行来源标记。
export type AgentRunOrigin = 'action'

export type AgentQuickAction =
  | 'setup'
  | 'reference'
  | 'world'
  | 'plan'
  | 'write-next'
  | 'recover-write'
  | 'continue'
  | 'rewrite'
  | 'review'
  | 'adjust-style'
  | 'revise-character'
  | 'revise-premise'
  | 'sync-chapter-memory'

export interface AgentRunTarget {
  sectionId: string
  tabId: string
  objectId: string
}

export type AgentMessageRole = 'user' | 'assistant' | 'system' | 'divider'
export type AgentRunActiveStatus = 'accepted' | 'running' | 'waiting-user' | 'cancelling' | 'durability-failed'
export type AgentRunTerminalStatus = 'complete' | 'failed' | 'cancelled' | 'interrupted'
export type AgentMessageStatus = 'running' | AgentRunTerminalStatus
export type AgentPartStatus = 'running' | 'complete' | 'failed'
export type AgentTaskPlanItemStatus = 'pending' | 'running' | 'complete' | 'failed'

export interface AgentTokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export interface AgentQuestionOption {
  label: string
  description: string
  preview?: string
}

export interface AgentQuestion {
  question: string
  header: string
  options: AgentQuestionOption[]
  multiSelect?: boolean
}

export interface AgentTaskPlanItem {
  id: string
  title: string
  status: AgentTaskPlanItemStatus
  detail?: string
}

export interface AgentTaskPlan {
  runId: string
  items: AgentTaskPlanItem[]
  updatedAt: string
}

// 子 agent 派发（Task/Agent 工具）折叠归属的一条子工具动作；精简展示字段，不携带 summary/result 全文。
export interface AgentSubToolCall {
  toolCallId: string
  toolName: string
  title: string
  status: AgentPartStatus
  input?: Record<string, unknown>
  error?: string
}

export type AgentMessagePart =
  | {
      id: string
      type: 'text'
      text: string
      status: AgentPartStatus
    }
  | {
      id: string
      type: 'reasoning'
      text: string
      status: AgentPartStatus
    }
  | {
      id: string
      type: 'tool-call'
      toolCallId: string
      toolName: string
      title: string
      status: AgentPartStatus
      input?: Record<string, unknown>
      summary?: string
      result?: string
      error?: string
      // 子 agent 分组卡：归属于本次派发（Task/Agent）的子工具动作，折叠显示当前动作、展开看明细。
      children?: AgentSubToolCall[]
    }
  | {
      id: string
      type: 'question'
      questionRequestId: string
      toolCallId: string
      questions: AgentQuestion[]
      answers?: Record<string, string>
      status: AgentPartStatus
      error?: string
    }
  | {
      id: string
      type: 'data'
      name: string
      title: string
      status: AgentPartStatus
      data?: unknown
    }
  | {
      id: string
      type: 'model-service-required'
      provider: string
      title: string
      detail: string
      status: 'failed'
    }
  | {
      id: string
      type: 'error'
      /** 旧记录缺省为 failed；interrupted 用于区分异常失败与 App 生命周期中断。 */
      tone?: 'failed' | 'interrupted'
      title: string
      detail?: string
      status: 'failed'
    }

export interface AgentMessage {
  id: string
  role: AgentMessageRole
  createdAt: string
  status: AgentMessageStatus
  parts: AgentMessagePart[]
  usage?: AgentTokenUsage
  // 触发本条 user 消息的指令（非 freeform 时存在）；用于在气泡前渲染指令中文标签（用户可见性）。
  command?: AgentQuickAction
  // 'action'：由工作台按钮（空页 CTA/状态页/评估 dock 等）发起，渲染为系统任务卡而非用户气泡。
  origin?: AgentRunOrigin
}

export interface AgentRun {
  id: string
  threadId: string
  command: AgentQuickAction | 'freeform'
  prompt: string
  // 气泡里显示给用户的干净文案；缺省时回退到 prompt。prompt 仍带定位元信息发给 Agent。
  displayPrompt?: string
  status: AgentRunActiveStatus | AgentRunTerminalStatus
  startedAt: string
  // 最近一次事件时间（运行中每条事件刷新）；UI 据「now - lastEventAt 超阈」判定长时间无响应。
  lastEventAt?: string
  // 主进程检测到连续静默后的提示时间；只提示，不释放锁。等待用户回答期间暂停计时。
  stalledAt?: string
  finishedAt?: string
  projectPath?: string
  selectedChapter?: number
  target?: AgentRunTarget
  taskPlan?: AgentTaskPlan
}

export interface AgentThread {
  id: string
  messages: AgentMessage[]
  activeRun: AgentRun | null
  lastRun: AgentRun | null
}

export type AgentDurableEventV1 =
  | {
      type: 'conversation.segment-opened'
      createdAt: string
    }
  | {
      type: 'conversation.segment-sealed'
      createdAt: string
    }
  | {
      type: 'conversation.divider-added'
      dividerId: string
      createdAt: string
    }
  | {
      type: 'run.accepted'
      runId: string
      command: AgentRun['command']
      visiblePrompt: string
      origin?: AgentRunOrigin
      selectedChapter?: number
      target?: AgentRunTarget
      createdAt: string
    }
  | {
      type: 'run.tool-summarized'
      runId: string
      messageId: string
      toolCallId: string
      toolName: string
      title: string
      status: 'complete' | 'failed'
      summary?: string
      error?: string
      /**
       * 工具操作的目标路径，已相对化为 `<项目>/…` / `<引擎>/…`（#37 取证）。
       * 无路径的工具（MCP 查询等）缺省；存量事件没有此字段，读取端按可选处理。
       */
      target?: string
      createdAt: string
    }
  | {
      type: 'run.question-requested'
      runId: string
      messageId: string
      questionRequestId: string
      toolCallId: string
      questions: AgentQuestion[]
      createdAt: string
    }
  | {
      type: 'run.question-answered'
      runId: string
      questionRequestId: string
      answers: Record<string, string>
      createdAt: string
    }
  | {
      type: 'run.plan-finalized'
      runId: string
      items: AgentTaskPlanItem[]
      createdAt: string
    }
  | {
      type: 'run.completed'
      runId: string
      assistantText: string
      usage?: AgentTokenUsage
      createdAt: string
    }
  | {
      type: 'run.failed'
      runId: string
      assistantText: string
      error: string
      reason?: 'model-service-required' | 'idle-timeout' | 'max-turns'
      provider?: string
      createdAt: string
    }
  | {
      type: 'run.cancelled'
      runId: string
      assistantText: string
      createdAt: string
    }
  | {
      type: 'run.interrupted'
      runId: string
      assistantText: string
      error: string
      createdAt: string
    }
  | {
      type: 'session.context-established'
      mode: 'direct' | 'project-command'
      compatibilityFingerprintHash: string
      createdAt: string
    }
  | {
      type: 'session.invalidated'
      reason: string
      createdAt: string
    }

export function getAgentThreadIdForProjectIdentity(project: {
  id: string
  path: string
}): string {
  const projectId = project.id.trim()
  if (projectId) return `novel:${projectId}`

  // Legacy projects may not have a novel id. Keep absolute paths out of durable thread identity.
  let hash = 0xcbf29ce484222325n
  for (const character of project.path.normalize('NFC')) {
    hash ^= BigInt(character.codePointAt(0) ?? 0)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `novel-path:${hash.toString(16).padStart(16, '0')}`
}

export interface AgentEventEnvelopeV1 {
  schemaVersion: 1
  eventId: string
  threadId: string
  segmentId: string
  runId?: string
  seq: number
  durability: 'durable' | 'transient'
  occurredAt: string
  payload: AgentDurableEventV1 | AgentEvent
}

export interface AgentHistorySegmentSummaryV1 {
  segmentId: string
  createdAt: string
  sealedAt?: string
  isActive: boolean
  hasUnreadableHistory?: boolean
}

export interface AgentThreadSnapshotV1 {
  schemaVersion: 1
  threadId: string
  segmentId: string
  lastSeq: number
  contextAvailable: boolean
  // 项目产物变更的单调递增版本；renderer 重连后据此判断是否需要重新加载项目视图。
  projectRevision: number
  history: AgentMessage[]
  activeRun: AgentRun | null
  lastRun: AgentRun | null
  previousSegmentId?: string
  hasUnreadableHistory?: boolean
}

export type AgentEventsAfterResultV1 =
  | {
      status: 'ok'
      events: AgentEventEnvelopeV1[]
    }
  | {
      status: 'snapshot-required'
    }

export interface AgentStartNewConversationInput {
  threadId: string
  requestId: string
}

export type AgentEvent =
  | {
      type: 'run.started'
      runId: string
      threadId: string
      command: AgentRun['command']
      prompt: string
      displayPrompt?: string
      origin?: AgentRunOrigin
      createdAt: string
      projectPath?: string
      selectedChapter?: number
      target?: AgentRunTarget
    }
  | {
      type: 'run.cancelling'
      runId: string
      createdAt: string
    }
  | {
      type: 'run.running'
      runId: string
      createdAt: string
    }
  | {
      type: 'run.stalled'
      runId: string
      createdAt: string
    }
  | {
      type: 'run.durability-failed'
      runId: string
      createdAt: string
    }
  | {
      type: 'message.delta'
      runId: string
      messageId: string
      text: string
      createdAt: string
    }
  | {
      type: 'reasoning.delta'
      runId: string
      messageId: string
      text: string
      createdAt: string
    }
  | {
      type: 'tool.started'
      runId: string
      messageId: string
      toolCallId: string
      toolName: string
      title: string
      input?: Record<string, unknown>
      // 子 agent 归属：该工具动作属于哪次派发（Task/Agent 工具的 toolCallId）；主会话动作缺省
      parentToolCallId?: string
      createdAt: string
    }
  | {
      type: 'tool.completed'
      runId: string
      toolCallId: string
      summary?: string
      result?: string
      // 子 agent 归属：该工具动作属于哪次派发（Task/Agent 工具的 toolCallId）；主会话动作缺省
      parentToolCallId?: string
      createdAt: string
    }
  | {
      type: 'tool.failed'
      runId: string
      toolCallId: string
      error: string
      // 子 agent 归属：该工具动作属于哪次派发（Task/Agent 工具的 toolCallId）；主会话动作缺省
      parentToolCallId?: string
      createdAt: string
    }
  | {
      type: 'question.requested'
      runId: string
      messageId: string
      questionRequestId: string
      toolCallId: string
      questions: AgentQuestion[]
      createdAt: string
    }
  | {
      type: 'question.answered'
      runId: string
      questionRequestId: string
      answers: Record<string, string>
      createdAt: string
    }
  | {
      type: 'run.completed'
      runId: string
      usage?: AgentTokenUsage
      createdAt: string
    }
  | {
      type: 'task-plan.updated'
      runId: string
      items: AgentTaskPlanItem[]
      createdAt: string
    }
  | {
      type: 'run.failed'
      runId: string
      error: string
      reason?: 'model-service-required' | 'idle-timeout' | 'max-turns'
      provider?: string
      createdAt: string
    }
  | {
      type: 'novel.project.updated'
      runId: string
      projectPath: string
      selectedChapter?: number
      target?: AgentRunTarget
      // 中途增量刷新（run 进行中、项目内 .md 产物落盘触发）。终态刷新不带此标记。
      transient?: boolean
      createdAt: string
    }
  | {
      type: 'run.cancelled'
      runId: string
      createdAt: string
    }
  | {
      type: 'run.interrupted'
      runId: string
      error: string
      createdAt: string
    }
