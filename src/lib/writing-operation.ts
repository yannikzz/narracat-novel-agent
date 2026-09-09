import type { AgentQuickAction, AgentRun, AgentThread } from '@shared/types/agent'
import type { AgentRunRequest } from '@shared/types/ipc'
import type { NarraCatArtifactKind } from '@shared/types/narracat'
import type { NovelArtifact, NovelChapterArtifacts } from '@shared/types/novel'

export type WritingOperationStatus = 'idle' | 'running' | 'complete' | 'failed' | 'cancelled'
export type WritingOperationPhaseStatus = 'pending' | 'running' | 'complete' | 'failed' | 'cancelled'
export type WritingOperationArtifactStatus = 'available' | 'missing' | 'error'

export interface WritingOperationPhase {
  id: 'preflight' | 'context' | 'manuscript' | 'review' | 'project'
  title: string
  detail: string
  status: WritingOperationPhaseStatus
  artifactKind?: NarraCatArtifactKind
}

export interface WritingOperationArtifactCard {
  kind: NarraCatArtifactKind
  title: string
  path: string
  status: WritingOperationArtifactStatus
  detail: string
}

export interface WritingOperationState {
  status: WritingOperationStatus
  title: string
  subtitle: string
  phases: WritingOperationPhase[]
  artifacts: WritingOperationArtifactCard[]
  availableArtifactCount: number
  missingArtifactCount: number
  erroredArtifactCount: number
  canCancel: boolean
  canRetry: boolean
  retryLabel?: string
  retryRequest?: AgentRunRequest
}

const SIDE_EFFECT_COMMAND_LABELS: Record<AgentQuickAction, string> = {
  setup: '设定',
  reference: '参考',
  world: '世界观',
  plan: '大纲',
  'write-next': '写作',
  'recover-write': '恢复',
  rewrite: '重写',
  review: '审修',
  'revise-premise': '改立项卡',
  'sync-chapter-memory': '同步记忆',
}

const PHASES: Omit<WritingOperationPhase, 'status'>[] = [
  {
    id: 'preflight',
    title: '写前预检',
    detail: '确认项目、设定和章节大纲可用',
  },
  {
    id: 'context',
    title: '上下文包',
    detail: '整理本章需要的设定、记忆和连续性信息',
    artifactKind: 'context-pack',
  },
  {
    id: 'manuscript',
    title: '章节正文',
    detail: '生成或更新本章正文稿',
    artifactKind: 'manuscript',
  },
  {
    id: 'review',
    title: '审修报告',
    detail: '检查情节、人物、连续性和可读性',
    artifactKind: 'review',
  },
  {
    id: 'project',
    title: '项目刷新',
    detail: '同步章节状态、记忆和 Workbench 产物',
  },
]

const ARTIFACT_ORDER: NarraCatArtifactKind[] = ['outline', 'context-pack', 'manuscript', 'review', 'deep-review']

export function getWritingOperationState(
  thread: AgentThread | undefined,
  chapterArtifacts: NovelChapterArtifacts | null,
  currentProjectPath?: string,
): WritingOperationState {
  const run = getCurrentOperationRun(thread)
  const artifacts = createArtifactCards(chapterArtifacts)
  const artifactCounts = countArtifacts(artifacts)

  if (!run) {
    return {
      status: 'idle',
      title: '写作操作台',
      subtitle: '自然语言对话仍然可用；写作类操作会在这里显示阶段和产物。',
      phases: createPhases('idle', thread, chapterArtifacts, undefined),
      artifacts,
      ...artifactCounts,
      canCancel: false,
      canRetry: false,
    }
  }

  const status = normalizeRunStatus(run.status)
  const title = createOperationTitle(run, chapterArtifacts)

  return {
    status,
    title,
    subtitle: createOperationSubtitle(run, status),
    phases: createPhases(status, thread, chapterArtifacts, run),
    artifacts,
    ...artifactCounts,
    canCancel:
      run.status === 'accepted' || run.status === 'running' || run.status === 'waiting-user',
    canRetry: status === 'failed' && Boolean(createRetryRequest(run, currentProjectPath)),
    retryLabel: createRetryLabel(run),
    retryRequest: createRetryRequest(run, currentProjectPath),
  }
}

function countArtifacts(artifacts: WritingOperationArtifactCard[]) {
  return {
    availableArtifactCount: artifacts.filter((artifact) => artifact.status === 'available').length,
    missingArtifactCount: artifacts.filter((artifact) => artifact.status === 'missing').length,
    erroredArtifactCount: artifacts.filter((artifact) => artifact.status === 'error').length,
  }
}

function getCurrentOperationRun(thread: AgentThread | undefined): AgentRun | null {
  const run = thread?.activeRun ?? thread?.lastRun ?? null
  if (!run || run.command === 'freeform') return null
  return run
}

function normalizeRunStatus(status: AgentRun['status']): WritingOperationStatus {
  if (
    status === 'accepted' ||
    status === 'running' ||
    status === 'waiting-user' ||
    status === 'cancelling'
  ) {
    return 'running'
  }
  if (status === 'durability-failed' || status === 'interrupted') return 'failed'
  return status
}

function createOperationTitle(run: AgentRun, chapterArtifacts: NovelChapterArtifacts | null): string {
  const chapter = getRunChapter(run) ?? chapterArtifacts?.chapterNumber
  if (run.command === 'write-next' && chapter) {
    if (run.status === 'running') return `第 ${chapter} 章写作中`
    return `第 ${chapter} 章写作${getTerminalStatusSuffix(run.status)}`
  }
  if (run.command === 'recover-write' && chapter) {
    if (run.status === 'running') return `第 ${chapter} 章恢复中`
    return `第 ${chapter} 章恢复${getTerminalStatusSuffix(run.status)}`
  }

  const label = run.command === 'freeform' ? '对话' : SIDE_EFFECT_COMMAND_LABELS[run.command]
  return run.status === 'running' ? `${label}进行中` : `${label}${getTerminalStatusSuffix(run.status)}`
}

function getRunChapter(run: AgentRun): number | undefined {
  if (run.selectedChapter) return run.selectedChapter

  const chapterTarget = [run.target?.objectId, run.target?.tabId]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.match(/^chapter-(\d+)$/)?.[1])
    .find(Boolean)

  if (!chapterTarget) return undefined
  const chapter = Number(chapterTarget)
  return Number.isSafeInteger(chapter) && chapter > 0 ? chapter : undefined
}

function getTerminalStatusSuffix(status: AgentRun['status']): string {
  switch (status) {
    case 'accepted':
    case 'running':
    case 'waiting-user':
      return '中'
    case 'cancelling':
      return '取消中'
    case 'durability-failed':
      return '等待历史恢复'
    case 'complete':
      return '完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    case 'interrupted':
      return '已中断'
  }
}

function createOperationSubtitle(run: AgentRun, status: WritingOperationStatus): string {
  if (status === 'running') return 'Agent 正在执行可追踪写作流程；你仍然可以随时取消。'
  if (run.status === 'interrupted') {
    return run.command === 'write-next' || run.command === 'recover-write'
      ? '上次运行未能正常收尾；可以从上次中断的地方继续。'
      : '上次运行未能正常收尾；继续前会先检查现有产物，避免重复写入。'
  }
  if (status === 'failed') return '本次操作失败，已保留可用输出；可以重试或继续自然语言调整。'
  if (status === 'cancelled') return '本次操作已取消；Workbench 会保留已生成的部分产物。'
  return '操作已结束；下方显示本章已生成的关键产物。'
}

function createPhases(
  status: WritingOperationStatus,
  thread: AgentThread | undefined,
  chapterArtifacts: NovelChapterArtifacts | null,
  run: AgentRun | undefined
): WritingOperationPhase[] {
  if (status === 'idle') {
    return PHASES.map((phase) => ({ ...phase, status: 'pending' }))
  }

  const completedPhaseIds = new Set<WritingOperationPhase['id']>()
  if (hasAssistantActivity(thread)) completedPhaseIds.add('preflight')
  if (hasArtifact(chapterArtifacts, 'context-pack')) completedPhaseIds.add('context')
  if (hasArtifact(chapterArtifacts, 'manuscript')) completedPhaseIds.add('manuscript')
  if (hasArtifact(chapterArtifacts, 'review')) completedPhaseIds.add('review')
  if (run?.status === 'complete') completedPhaseIds.add('project')

  if (run?.status === 'complete') {
    completedPhaseIds.add('preflight')
  }

  let markedCurrent = false
  return PHASES.map((phase) => {
    if (completedPhaseIds.has(phase.id)) {
      return { ...phase, status: 'complete' as const }
    }

    if (!markedCurrent && status !== 'complete') {
      markedCurrent = true
      return { ...phase, status: status === 'running' ? 'running' : status }
    }

    return { ...phase, status: 'pending' as const }
  })
}

function hasAssistantActivity(thread: AgentThread | undefined): boolean {
  return Boolean(thread?.messages.some((message) => message.role === 'assistant' && message.parts.length > 0))
}

function hasArtifact(chapterArtifacts: NovelChapterArtifacts | null, kind: NarraCatArtifactKind): boolean {
  return Boolean(chapterArtifacts?.artifacts.some((artifact) => artifact.kind === kind && artifact.exists))
}

function createArtifactCards(chapterArtifacts: NovelChapterArtifacts | null): WritingOperationArtifactCard[] {
  const artifacts = chapterArtifacts?.artifacts ?? []
  return [...artifacts]
    .sort((left, right) => ARTIFACT_ORDER.indexOf(left.kind) - ARTIFACT_ORDER.indexOf(right.kind))
    .map(createArtifactCard)
}

function createArtifactCard(artifact: NovelArtifact): WritingOperationArtifactCard {
  if (artifact.error) {
    return {
      kind: artifact.kind,
      title: artifact.title,
      path: artifact.path,
      status: 'error',
      detail: artifact.error,
    }
  }

  return {
    kind: artifact.kind,
    title: artifact.title,
    path: artifact.path,
    status: artifact.exists ? 'available' : 'missing',
    detail: artifact.exists ? '已生成' : '等待生成',
  }
}

function createRetryLabel(run: AgentRun): string | undefined {
  if (run.status !== 'interrupted') return '重试'
  return run.command === 'write-next' || run.command === 'recover-write'
    ? '继续完成本章'
    : '检查并继续'
}

function createRetryRequest(
  run: AgentRun,
  currentProjectPath?: string,
): AgentRunRequest | undefined {
  if (run.command === 'freeform') return undefined
  const projectPath = run.projectPath ?? currentProjectPath

  if (run.status === 'interrupted') {
    if (!projectPath) return undefined
    if (run.command === 'write-next' || run.command === 'recover-write') {
      return {
        threadId: run.threadId,
        command: 'recover-write',
        prompt: '继续完成本章',
        projectPath,
        ...(run.selectedChapter ? { selectedChapter: run.selectedChapter } : {}),
        ...(run.target ? { target: run.target } : {}),
      }
    }
    return {
      threadId: run.threadId,
      command: 'freeform',
      prompt: `上次“${run.prompt}”任务因 App 退出而中断。请先检查项目中已经生成或修改的产物，说明当前状态和还缺什么；只在确认不会重复既有写入后继续完成未完成部分。`,
      projectPath,
      engineContext: true,
      ...(run.selectedChapter ? { selectedChapter: run.selectedChapter } : {}),
      ...(run.target ? { target: run.target } : {}),
    }
  }

  const request: AgentRunRequest = {
    threadId: run.threadId,
    command: run.command,
    prompt: run.prompt,
  }

  if (projectPath) request.projectPath = projectPath
  if (run.selectedChapter) request.selectedChapter = run.selectedChapter
  if (run.target) request.target = run.target

  return request
}
