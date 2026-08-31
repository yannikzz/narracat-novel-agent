import type { AgentQuickAction, AgentRunTarget } from '@shared/types/agent'
import type {
  AgentCancelRunInput,
  AgentQuestionAnswerInput,
  AgentQuestionAnswerMutationInput,
  AgentRunRequest,
  AgentRunStarted,
} from '@shared/types/agent-run'

export type {
  AgentCancelRunInput,
  AgentQuestionAnswerInput,
  AgentQuestionAnswerMutationInput,
  AgentRunRequest,
  AgentRunStarted,
} from '@shared/types/agent-run'

const AGENT_COMMANDS = new Set<AgentRunRequest['command']>([
  'setup',
  'reference',
  'world',
  'plan',
  'write-next',
  'recover-write',
  'continue',
  'rewrite',
  'review',
  'adjust-style',
  'revise-character',
  'revise-premise',
  'sync-chapter-memory',
  'freeform',
])
const AGENT_TARGET_SECTIONS = new Set(['blueprint', 'settings', 'reference-works'])

/** prompt 允许为空的命令：见下方校验处的理由。与渲染端 resolveAgentRunPrompt 的同名集合成对。 */
const AUTHOR_INTENT_ONLY_COMMANDS = new Set<AgentRunRequest['command']>(['write-next', 'recover-write'])

export function normalizeAgentRunRequest(input: unknown): AgentRunRequest {
  if (!input || typeof input !== 'object') throw new Error('Agent 任务参数非法。')

  const { requestId, threadId, command, prompt, displayPrompt, origin, engineContext, projectPath, selectedChapter, target } =
    input as Record<string, unknown>
  if (requestId !== undefined && (typeof requestId !== 'string' || !requestId.trim())) {
    throw new Error('Agent 任务 requestId 非法。')
  }
  if (typeof threadId !== 'string' || !threadId.trim()) throw new Error('Agent 任务缺少 threadId。')
  if (typeof command !== 'string' || !AGENT_COMMANDS.has(command as AgentRunRequest['command'])) {
    throw new Error('Agent 任务 command 非法。')
  }
  // 章节写作命令的 prompt 是「作者补充意图」而非任务内容——任务由章号与细纲决定（intent 恒为章号），
  // 作者没补充时渲染端就传空串，避免产品默认文案（「写下一章」/「写本章」）被引擎当成作者提的要求。
  // 其余命令的 prompt 就是 $ARGUMENTS，空仍然非法。
  if (typeof prompt !== 'string') throw new Error('Agent 任务缺少 prompt。')
  if (!prompt.trim() && !AUTHOR_INTENT_ONLY_COMMANDS.has(command as AgentRunRequest['command'])) {
    throw new Error('Agent 任务缺少 prompt。')
  }

  const normalized: AgentRunRequest = {
    ...(typeof requestId === 'string' ? { requestId: requestId.trim() } : {}),
    threadId,
    command: command as AgentRunRequest['command'],
    prompt,
  }

  if (typeof displayPrompt === 'string' && displayPrompt.trim()) {
    normalized.displayPrompt = displayPrompt
  }

  if (origin !== undefined) {
    if (origin !== 'action') throw new Error('Agent 任务 origin 非法。')
    normalized.origin = origin
  }

  if (engineContext !== undefined) {
    if (typeof engineContext !== 'boolean') throw new Error('Agent 任务 engineContext 非法。')
    normalized.engineContext = engineContext
  }

  if (typeof projectPath === 'string' && projectPath.trim()) {
    normalized.projectPath = projectPath
  }

  if (selectedChapter !== undefined) {
    if (typeof selectedChapter !== 'number' || !Number.isInteger(selectedChapter) || selectedChapter < 1) {
      throw new Error('Agent 任务 selectedChapter 非法。')
    }
    normalized.selectedChapter = selectedChapter
  }

  if (target !== undefined) {
    normalized.target = normalizeAgentRunTarget(target)
  }

  return normalized
}

function normalizeAgentRunTarget(input: unknown): AgentRunTarget {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Agent 任务 target 非法。')

  const { sectionId, tabId, objectId } = input as Record<string, unknown>
  if (typeof sectionId !== 'string' || !sectionId.trim()) throw new Error('Agent 任务 target 非法。')
  if (!AGENT_TARGET_SECTIONS.has(sectionId)) throw new Error('Agent 任务 target 非法。')
  if (typeof tabId !== 'string' || !tabId.trim()) throw new Error('Agent 任务 target 非法。')
  if (typeof objectId !== 'string' || !objectId.trim()) throw new Error('Agent 任务 target 非法。')

  return { sectionId, tabId, objectId }
}

export function normalizeAgentQuestionAnswer(input: unknown): AgentQuestionAnswerMutationInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Agent 问题答案参数非法。')

  const { requestId, questionRequestId, answers } = input as Record<string, unknown>
  if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('Agent 问题缺少 requestId。')
  if (questionRequestId !== undefined && (typeof questionRequestId !== 'string' || !questionRequestId.trim())) {
    throw new Error('Agent 问题 questionRequestId 非法。')
  }
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('Agent 问题答案非法。')

  const normalizedAnswers: Record<string, string> = {}
  for (const [question, answer] of Object.entries(answers)) {
    if (typeof answer !== 'string') throw new Error('Agent 问题答案非法。')
    if (question.trim() && answer.trim()) normalizedAnswers[question] = answer
  }

  if (Object.keys(normalizedAnswers).length === 0) throw new Error('Agent 问题答案为空。')
  return {
    requestId: requestId.trim(),
    // 兼容旧 renderer：升级窗口尚未重载时，旧 payload 的 requestId 仍指向问题本身。
    questionRequestId:
      typeof questionRequestId === 'string' && questionRequestId.trim()
        ? questionRequestId.trim()
        : requestId.trim(),
    answers: normalizedAnswers,
  }
}

export function normalizeAgentCancelRun(input: unknown): AgentCancelRunInput {
  if (typeof input === 'string' && input.trim()) {
    return { requestId: input.trim(), runId: input.trim() }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Agent 取消参数非法。')
  const { requestId, runId } = input as Record<string, unknown>
  if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('Agent 取消缺少 requestId。')
  if (typeof runId !== 'string' || !runId.trim()) throw new Error('Agent runId 参数非法。')
  return { requestId: requestId.trim(), runId: runId.trim() }
}
