import type { AgentQuestion, AgentRun } from '@shared/types/agent'
import type { PackLearnResult, PackLearnSource } from '@shared/types/capability-pack'
import type { ResultNotification, ResultNotificationList, ResultNotificationStatus } from '@shared/types/notifications'

const MAX_RESULT_NOTIFICATIONS = 100
const DEFAULT_RECENT_RESULT_NOTIFICATIONS = 20

type ResultNotificationAction =
  | { type: 'upsert'; notification: ResultNotification }
  | { type: 'mark-read'; id: string; readAt: string }
  | { type: 'mark-all-read'; readAt: string }

export interface ResultNotificationDraftInput {
  error?: string
  occurredAt: string
  projectName: string
  run: AgentRun
  status: Extract<ResultNotificationStatus, 'success' | 'failed' | 'interrupted'>
}

export interface QuestionNotificationDraftInput {
  occurredAt: string
  projectName: string
  questionRequestId: string
  questions: AgentQuestion[]
  run: AgentRun
}

export function resultNotificationIdForRun(runId: string): string {
  return `notification-${runId}`
}

function chapterNumberFromRun(run: AgentRun): number | undefined {
  if (run.selectedChapter) return run.selectedChapter

  const rawId = run.target?.objectId ?? run.target?.tabId ?? ''
  const match = rawId.match(/^chapter-(\d+)$/)
  if (!match) return undefined

  const parsed = Number(match[1])
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function volumeNumberFromRun(run: AgentRun): number | undefined {
  const rawId = run.target?.objectId ?? run.target?.tabId ?? ''
  const match = rawId.match(/^volume-(?:outline-)?(\d+)$/)
  if (!match) return undefined

  const parsed = Number(match[1])
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function resultBaseTitle(run: AgentRun): string {
  const chapterNumber = chapterNumberFromRun(run)
  if ((run.command === 'write-next' || run.command === 'recover-write') && chapterNumber) {
    return `第 ${chapterNumber} 章正文`
  }

  if (run.command === 'plan') {
    const volumeNumber = volumeNumberFromRun(run)
    if (volumeNumber) return `第 ${volumeNumber} 卷大纲`
    return '全局大纲'
  }

  if (run.command === 'setup') return '创作根基'
  if (run.command === 'reference') return '参考作品分析'
  if (run.command === 'world') return '世界观设定'
  if (run.command === 'review') return '审修报告'
  if (run.command === 'revise-premise') return '创作根基'
  if (run.command === 'sync-chapter-memory') return '记忆同步'
  if (run.command === 'rewrite') return '内容调整'

  return 'Agent 任务'
}

function successSummary(run: AgentRun): string {
  if (run.command === 'write-next' || run.command === 'recover-write') return 'Agent 已完成章节正文生成。'
  if (run.command === 'review') return 'Agent 已完成审修报告生成。'
  if (run.command === 'reference') return 'Agent 已完成参考作品分析。'
  return 'Agent 已完成任务。'
}

export function createResultNotificationDraft({
  occurredAt,
  projectName,
  run,
  status,
}: ResultNotificationDraftInput): ResultNotification {
  const baseTitle = resultBaseTitle(run)
  const title =
    status === 'success'
      ? `${baseTitle}已生成`
      : status === 'interrupted'
        ? `${baseTitle}已中断`
        : `${baseTitle}生成失败`

  return {
    id: resultNotificationIdForRun(run.id),
    runId: run.id,
    threadId: run.threadId,
    status,
    title,
    summary:
      status === 'success'
        ? successSummary(run)
        : status === 'interrupted'
          ? 'Agent 任务已中断，可检查已有产物后继续。'
          : 'Agent 运行失败，已保留可用上下文。',
    projectName,
    ...(run.projectPath ? { projectPath: run.projectPath } : {}),
    command: run.command,
    ...(run.target ? { target: run.target } : {}),
    createdAt: occurredAt,
    updatedAt: occurredAt,
  }
}

const PACK_LEARN_ERROR_MESSAGE_MAX_LENGTH = 120

/**
 * 「从书学写法」终态通知（刀4 终审 follow-up：学习是分钟级后台任务，用户切走后没有全局提示）。
 * 学习产物是造包草稿，不挂在某个小说项目的工作台对象上——用不了 `run.target` 的工作台路由，
 * 改走 `href` 直达设置页「我的创作」（成功直落到具体草稿编辑器，失败落到草稿列表方便重试）。
 */
export interface PackLearnResultNotificationDraftInput {
  occurredAt: string
  result: Extract<PackLearnResult, { status: 'ok' } | { status: 'error' }>
  source: PackLearnSource
}

function packLearnSourceKey(source: PackLearnSource): string {
  return source.kind === 'novel' ? source.projectPath : source.filePath
}

/** 通知 id 的落点：成功按 draftId（每次成功学习都产出新草稿，天然不重）；失败按书源
 *  （同一本书重复学失败会更新同一条通知而非刷屏，符合「这本书目前学不出来」的语义）。 */
function packLearnRunId(source: PackLearnSource, result: PackLearnResultNotificationDraftInput['result']): string {
  return result.status === 'ok' ? `pack-learn-${result.draftId}` : `pack-learn-error-${packLearnSourceKey(source)}`
}

function packLearnHref(sub: string): string {
  return `/settings?${new URLSearchParams({ section: 'packs', sub }).toString()}`
}

function packLearnErrorSummary(message: string): string {
  return message.length <= PACK_LEARN_ERROR_MESSAGE_MAX_LENGTH
    ? message
    : `${message.slice(0, PACK_LEARN_ERROR_MESSAGE_MAX_LENGTH)}...`
}

export function createPackLearnResultNotificationDraft({
  occurredAt,
  result,
  source,
}: PackLearnResultNotificationDraftInput): ResultNotification {
  const runId = packLearnRunId(source, result)
  const status: ResultNotificationStatus = result.status === 'ok' ? 'success' : 'failed'

  return {
    id: resultNotificationIdForRun(runId),
    runId,
    threadId: runId,
    status,
    title: result.status === 'ok' ? `《${source.title}》学完了` : `《${source.title}》这次没学成`,
    summary:
      result.status === 'ok' ? `留下 ${result.report.cardsKept} 张卡` : packLearnErrorSummary(result.message),
    projectName: source.title,
    href: result.status === 'ok' ? packLearnHref(`draft:${result.draftId}`) : packLearnHref('creations'),
    createdAt: occurredAt,
    updatedAt: occurredAt,
  }
}

function questionSummary(questions: AgentQuestion[]): string {
  const firstQuestion = questions[0]?.question.trim()
  if (!firstQuestion) return 'Agent 需要你确认下一步。'
  if (firstQuestion.length <= 48) return firstQuestion
  return `${firstQuestion.slice(0, 48)}...`
}

export function createQuestionNotificationDraft({
  occurredAt,
  projectName,
  questionRequestId,
  questions,
  run,
}: QuestionNotificationDraftInput): ResultNotification {
  return {
    id: resultNotificationIdForRun(run.id),
    runId: run.id,
    threadId: run.threadId,
    status: 'waiting',
    title: 'Agent 等待你确认',
    summary: questionSummary(questions),
    projectName,
    ...(run.projectPath ? { projectPath: run.projectPath } : {}),
    command: run.command,
    ...(run.target ? { target: run.target } : {}),
    questionRequestId,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  }
}

const ACTIVE_NOTIFICATION_STATUSES = new Set<ResultNotificationStatus>(['running', 'waiting', 'cancelling'])

function compareNotifications(left: ResultNotification, right: ResultNotification): number {
  const activeRank =
    Number(ACTIVE_NOTIFICATION_STATUSES.has(right.status)) -
    Number(ACTIVE_NOTIFICATION_STATUSES.has(left.status))
  if (activeRank !== 0) return activeRank
  const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  if (Number.isFinite(updated) && updated !== 0) return updated
  return right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt)
}

export function reduceResultNotifications(
  notifications: ResultNotification[],
  action: ResultNotificationAction,
): ResultNotification[] {
  if (action.type === 'mark-read') {
    return notifications.map((notification) =>
      notification.id === action.id && !notification.readAt
        ? { ...notification, readAt: action.readAt }
        : notification,
    )
  }

  if (action.type === 'mark-all-read') {
    return notifications.map((notification) =>
      notification.readAt ? notification : { ...notification, readAt: action.readAt },
    )
  }

  const previous = notifications.find(
    (notification) => notification.id === action.notification.id || notification.runId === action.notification.runId,
  )
  const notification = previous
    ? {
        ...action.notification,
        createdAt: previous.createdAt,
        ...(action.notification.projectName === '未关联项目'
          ? { projectName: previous.projectName }
          : {}),
        ...(!action.notification.projectPath && previous.projectPath
          ? { projectPath: previous.projectPath }
          : {}),
        ...(!action.notification.target && previous.target ? { target: previous.target } : {}),
        ...(!action.notification.command && previous.command ? { command: previous.command } : {}),
        ...(!action.notification.href && previous.href ? { href: previous.href } : {}),
        ...(!action.notification.segmentId && previous.segmentId
          ? { segmentId: previous.segmentId }
          : {}),
      }
    : action.notification

  const next = [
    notification,
    ...notifications.filter(
      (notification) => notification.id !== action.notification.id && notification.runId !== action.notification.runId,
    ),
  ].sort(compareNotifications)

  return next.slice(0, MAX_RESULT_NOTIFICATIONS)
}

export function getRecentResultNotifications(
  notifications: ResultNotification[],
  limit = DEFAULT_RECENT_RESULT_NOTIFICATIONS,
): ResultNotification[] {
  return [...notifications].sort(compareNotifications).slice(0, limit)
}

export function createResultNotificationList(notifications: ResultNotification[], limit = DEFAULT_RECENT_RESULT_NOTIFICATIONS): ResultNotificationList {
  return {
    notifications: getRecentResultNotifications(notifications, limit),
    totalCount: notifications.length,
    unreadCount: notifications.filter(
      (notification) =>
        !notification.readAt &&
        notification.status !== 'running' &&
        notification.status !== 'cancelling',
    ).length,
  }
}
