import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  AgentEvent,
  AgentEventEnvelopeV1,
  AgentEventsAfterResultV1,
  AgentHistorySegmentSummaryV1,
  AgentStartNewConversationInput,
  AgentThreadSnapshotV1,
  AgentRunActiveStatus,
} from '@shared/types/agent'
import { getAgentThreadIdForProjectIdentity } from '@shared/types/agent'
import type {
  AgentCancelRunInput,
  AgentQuestionAnswerMutationInput,
  AgentRunRequest,
  AgentRunStarted,
} from '../../agent-runner.ts'
import type { AgentConversationStore } from '../events/agent-conversation-store.ts'
import { createAgentEventSink } from '../events/agent-event-sink.ts'
import type { AgentRunManager } from './run-manager.ts'

export interface AgentProjectIdentity {
  id?: string
  path: string
}

export interface AgentRuntimeSubscriber {
  id: string
  send: (event: AgentEventEnvelopeV1) => void
}

export interface AgentRuntimeCoordinatorDeps {
  store: AgentConversationStore
  createRunManager: (
    sendEvent: (event: AgentEvent) => Promise<void>,
    sessionLifecycle: {
      established: (
        threadId: string,
        mode: 'direct' | 'project-command',
        compatibilityFingerprintHash: string,
      ) => Promise<void>
      invalidated: (threadId: string, reason: string) => Promise<void>
    },
  ) => AgentRunManager
  resolveProjectIdentity: (projectPath: string) => Promise<AgentProjectIdentity>
  beforeBroadcast?: (event: AgentEventEnvelopeV1) => void | Promise<void>
  onSideEffectError?: (error: unknown, event: AgentEventEnvelopeV1) => void
  /** Agent Core 根路径，透传给 sink 做路径取证的已知根（#37）。 */
  agentCorePath?: string
}

export interface AgentRuntimeCoordinator {
  subscribe: (subscriber: AgentRuntimeSubscriber) => () => void
  startRun: (request: AgentRunRequest & { requestId: string }) => Promise<AgentRunStarted>
  cancelRun: (input: AgentCancelRunInput) => Promise<{ cancelled: boolean }>
  answerQuestion: (input: AgentQuestionAnswerMutationInput) => Promise<{ accepted: boolean }>
  forgetThreadSession: (input: { threadId: string; requestId: string }) => Promise<void>
  getThreadSnapshot: (threadId: string, segmentId?: string) => Promise<AgentThreadSnapshotV1>
  getEventsAfter: (threadId: string, segmentId: string, afterSeq: number) => Promise<AgentEventsAfterResultV1>
  listHistorySegments: (threadId: string) => Promise<AgentHistorySegmentSummaryV1[]>
  startNewConversation: (input: AgentStartNewConversationInput) => Promise<AgentThreadSnapshotV1>
  reconcileStartup: () => Promise<number>
  settleActiveRuns: () => Promise<void>
  interruptAllForQuit: () => Promise<void>
  invalidateAllSessions: (reason: string) => Promise<void>
  getProjectActivity: (projectPath: string) => Promise<{
    active: boolean
    threadId?: string
    runId?: string
    status?: AgentRunActiveStatus
  }>
  hasActiveRunForThread: (threadId: string) => boolean
  hasActiveRuns: () => boolean
  runProjectMutation: <T>(projectPath: string, operation: () => Promise<T>) => Promise<T>
  runProjectBackup: <T>(projectPath: string, operation: () => Promise<T>) => Promise<T>
}

interface ProjectLock {
  requestId: string
  threadId: string
  runId?: string
}

function projectBusyError(lock: ProjectLock): Error {
  const error = new Error(
    `project-busy: 当前小说已有 Agent 任务运行中（threadId=${lock.threadId}${lock.runId ? `, runId=${lock.runId}` : ''}）。`,
  )
  error.name = 'AgentProjectBusyError'
  return error
}

function projectBackupBusyError(): Error {
  const error = new Error('project-backup-busy: 当前小说正在备份，暂时无法写入或启动 Agent。')
  error.name = 'NovelProjectBackupBusyError'
  return error
}

function projectMutationBusyError(): Error {
  const error = new Error('project-mutation-busy: 当前小说有保存或恢复操作尚未完成，暂时无法备份。')
  error.name = 'NovelProjectMutationBusyError'
  return error
}

const MUTATION_CACHE_LIMIT = 512

async function canonicalProjectKey(
  projectPath: string,
  resolveProjectIdentity: AgentRuntimeCoordinatorDeps['resolveProjectIdentity'],
): Promise<string> {
  const identity = await resolveProjectIdentity(projectPath)
  const id = identity.id?.trim()
  if (id && id !== identity.path) return `novel:${id}`
  const canonical = await realpath(identity.path).catch(() => resolve(identity.path))
  return `path:${canonical.normalize('NFC')}`
}

/**
 * App 生命周期唯一的 Agent 协调器。
 *
 * renderer 只是可随时断开的观察者；run、问题、SDK session、项目锁和幂等请求都归本模块。
 */
export function createAgentRuntimeCoordinator(deps: AgentRuntimeCoordinatorDeps): AgentRuntimeCoordinator {
  const subscribers = new Map<string, AgentRuntimeSubscriber['send']>()
  const projectLocks = new Map<string, ProjectLock>()
  const projectKeysByRun = new Map<string, string>()
  const pendingProjectKeysByThread = new Map<string, string>()
  const projectBackupLocks = new Set<string>()
  const projectMutationCounts = new Map<string, number>()
  const mutationResults = new Map<string, Promise<unknown>>()

  function rememberMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = mutationResults.get(key)
    if (existing) return existing as Promise<T>
    const result = operation()
    mutationResults.set(key, result)
    if (mutationResults.size > MUTATION_CACHE_LIMIT) {
      mutationResults.delete(mutationResults.keys().next().value!)
    }
    return result
  }

  function broadcast(event: AgentEventEnvelopeV1): void {
    for (const send of subscribers.values()) {
      try {
        send(event)
      } catch {
        // renderer 消失不影响主进程状态机和 durable commit。
      }
    }
  }

  function releaseProjectLockForRun(runId: string): void {
    const projectKey = projectKeysByRun.get(runId)
    if (!projectKey) return
    projectKeysByRun.delete(runId)
    projectLocks.delete(projectKey)
  }

  const sink = createAgentEventSink({
    store: deps.store,
    broadcast,
    ...(deps.agentCorePath ? { agentCorePath: deps.agentCorePath } : {}),
    beforeBroadcast: async (envelope) => {
      try {
        await deps.beforeBroadcast?.(envelope)
      } finally {
        const payload = envelope.payload
        if (
          envelope.durability === 'durable' &&
          (payload.type === 'run.completed' ||
            payload.type === 'run.failed' ||
            payload.type === 'run.cancelled')
        ) {
          releaseProjectLockForRun(payload.runId)
        }
      }
    },
    onSideEffectError: deps.onSideEffectError,
  })

  async function publishFromRunManager(event: AgentEvent): Promise<void> {
    if (event.type === 'run.started') {
      const projectKey = pendingProjectKeysByThread.get(event.threadId)
      if (projectKey) {
        projectKeysByRun.set(event.runId, projectKey)
        const lock = projectLocks.get(projectKey)
        if (lock) lock.runId = event.runId
      }
    }
    try {
      await sink.publish(event)
    } catch (error) {
      if (event.type !== 'run.started' && projectKeysByRun.has(event.runId)) {
        await sink
          .publish({ type: 'run.durability-failed', runId: event.runId, createdAt: event.createdAt })
          .catch(() => undefined)
      }
      throw error
    }
  }

  const manager = deps.createRunManager(publishFromRunManager, {
    established: (threadId, mode, compatibilityFingerprintHash) =>
      sink.establishSessionContext(threadId, mode, compatibilityFingerprintHash),
    invalidated: (threadId, reason) => sink.invalidateSessionContext(threadId, reason),
  })

  return {
    subscribe(subscriber) {
      subscribers.set(subscriber.id, subscriber.send)
      return () => {
        if (subscribers.get(subscriber.id) === subscriber.send) subscribers.delete(subscriber.id)
      }
    },

    startRun(request) {
      return rememberMutation(`start:${request.requestId}`, async () => {
        let projectKey = 'global'
        let expectedThreadId: string | undefined
        if (request.projectPath) {
          const identity = await deps.resolveProjectIdentity(request.projectPath)
          expectedThreadId = getAgentThreadIdForProjectIdentity({
            id: identity.id ?? '',
            path: identity.path,
          })
          projectKey = await canonicalProjectKey(request.projectPath, async () => identity)
        }
        const existing = projectLocks.get(projectKey)
        if (existing) {
          throw projectBusyError(existing)
        }
        if (projectBackupLocks.has(projectKey)) throw projectBackupBusyError()
        if (expectedThreadId && request.threadId !== expectedThreadId) {
          throw new Error('Agent threadId 与当前小说身份不匹配。')
        }

        projectLocks.set(projectKey, { requestId: request.requestId, threadId: request.threadId })
        pendingProjectKeysByThread.set(request.threadId, projectKey)
        try {
          return await manager.startRun(request)
        } catch (error) {
          projectLocks.delete(projectKey)
          throw error
        } finally {
          if (pendingProjectKeysByThread.get(request.threadId) === projectKey) {
            pendingProjectKeysByThread.delete(request.threadId)
          }
        }
      })
    },

    cancelRun(input) {
      return rememberMutation(`cancel:${input.requestId}`, () => manager.cancelRun(input.runId))
    },

    answerQuestion(input) {
      return rememberMutation(`answer:${input.requestId}`, () =>
        manager.answerQuestion({ requestId: input.questionRequestId, answers: input.answers }),
      )
    },

    forgetThreadSession(input) {
      return rememberMutation(`forget:${input.requestId}`, async () => {
        manager.forgetThreadSession(input.threadId)
        await sink.invalidateSessionContext(input.threadId, 'explicit-forget')
      })
    },

    async getThreadSnapshot(threadId, segmentId) {
      const snapshot = await sink.getThreadSnapshot(threadId, segmentId)
      return { ...snapshot, contextAvailable: manager.hasThreadSession(threadId) }
    },

    getEventsAfter(threadId, segmentId, afterSeq) {
      return sink.getEventsAfter(threadId, segmentId, afterSeq)
    },

    listHistorySegments(threadId) {
      return sink.listHistorySegments(threadId)
    },

    startNewConversation(input) {
      return rememberMutation(`new-conversation:${input.requestId}`, async () => {
        if (manager.hasActiveRunForThread(input.threadId)) {
          throw new Error('当前 Agent 仍在运行，无法开始新对话。')
        }
        manager.forgetThreadSession(input.threadId)
        await sink.invalidateSessionContext(input.threadId, 'new-conversation')
        const snapshot = await sink.startNewConversation(input.threadId, input.requestId)
        return { ...snapshot, contextAvailable: false }
      })
    },

    reconcileStartup() {
      return sink.reconcileInterruptedRuns()
    },

    settleActiveRuns() {
      return manager.settleActiveRuns()
    },

    async interruptAllForQuit() {
      await manager.invalidateAllThreadSessions('app-quitting')
      await manager.settleActiveRuns()
    },

    invalidateAllSessions(reason) {
      return manager.invalidateAllThreadSessions(reason)
    },

    async getProjectActivity(projectPath) {
      const projectKey = await canonicalProjectKey(projectPath, deps.resolveProjectIdentity)
      const lock = projectLocks.get(projectKey)
      if (!lock) return { active: false }
      return {
        active: true,
        threadId: lock.threadId,
        ...(lock.runId ? { runId: lock.runId, status: manager.getRunStatus(lock.runId) } : {}),
      }
    },

    hasActiveRunForThread(threadId) {
      return manager.hasActiveRunForThread(threadId)
    },

    hasActiveRuns() {
      return manager.hasActiveRuns()
    },

    async runProjectMutation(projectPath, operation) {
      const projectKey = await canonicalProjectKey(projectPath, deps.resolveProjectIdentity)
      if (projectBackupLocks.has(projectKey)) throw projectBackupBusyError()
      projectMutationCounts.set(projectKey, (projectMutationCounts.get(projectKey) ?? 0) + 1)
      try {
        return await operation()
      } finally {
        const remaining = (projectMutationCounts.get(projectKey) ?? 1) - 1
        if (remaining > 0) projectMutationCounts.set(projectKey, remaining)
        else projectMutationCounts.delete(projectKey)
      }
    },

    async runProjectBackup(projectPath, operation) {
      const projectKey = await canonicalProjectKey(projectPath, deps.resolveProjectIdentity)
      const agentLock = projectLocks.get(projectKey)
      if (agentLock) throw projectBusyError(agentLock)
      if (projectBackupLocks.has(projectKey)) throw projectBackupBusyError()
      if ((projectMutationCounts.get(projectKey) ?? 0) > 0) throw projectMutationBusyError()
      projectBackupLocks.add(projectKey)
      try {
        return await operation()
      } finally {
        projectBackupLocks.delete(projectKey)
      }
    },
  }
}
