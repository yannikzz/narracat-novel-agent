import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { getApiKey } from '../secrets.ts'
import {
  normalizeAgentCancelRun,
  normalizeAgentQuestionAnswer,
  normalizeAgentRunRequest,
  type AgentRunStarted,
} from '../agent-runner.ts'
import { markResultNotificationRead, upsertResultNotification } from '../notifications.ts'
import { createAgentRunManager } from '../agent/runs/run-manager.ts'
import { createAgentConversationStore } from '../agent/events/agent-conversation-store.ts'
import {
  createAgentRuntimeCoordinator,
  type AgentRuntimeCoordinator,
} from '../agent/runs/agent-runtime-coordinator.ts'
import { createAgentSessionCompatibilityFingerprint } from '../agent/runs/session-fingerprint.ts'
import { createAgentMainSideEffects } from '../agent/events/agent-main-side-effects.ts'
import { recordChapterWrite } from '../telemetry/telemetry-runtime.ts'
import { NARRACAT_AGENT_CORE_VERSION_LOCK } from '../engine/agent-core-contract.ts'
import { resolveNarraCatAgentCorePath } from '../engine/engine.ts'
import type {
  AgentEventsAfterResultV1,
  AgentHistorySegmentSummaryV1,
  AgentStartNewConversationInput,
  AgentThreadSnapshotV1,
} from '@shared/types/agent'
import { loadNovelProjectSummary } from '../novel/novel-project.ts'
import { clearPendingMemorySync } from '../novel/pending-memory-sync.ts'
import { openMemoryDbReadonly } from '../novel/memory-db.ts'
import { hasAgentWriteWithinRun, runStandingPolish } from '../polish/standing-polish.ts'
import { broadcastPolishEvent, createHeadlessPolishRunManager } from '../polish/polish-runtime.ts'
import { manuscriptRevisionStore } from '../novel/manuscript-revisions.ts'
import {
  broadcastResultNotifications,
  readCurrentConfig,
  readInputRecord,
  readOptionalString,
  readRequiredString,
  resultNotificationsPath,
  showNativeResultNotificationIfNeeded,
  userDataPath,
} from './inputs.ts'

const agentRuntimeUnsubscribers = new WeakMap<Electron.WebContents, () => void>()
let _agentRuntimeCoordinator: AgentRuntimeCoordinator | null = null

export function getAgentRuntimeCoordinator(): AgentRuntimeCoordinator {
  if (!_agentRuntimeCoordinator) {
    const store = createAgentConversationStore({
      rootDir: userDataPath(),
      onCacheWriteError(error, context) {
        console.error('Agent conversation cache refresh failed:', context, error)
      },
    })
    const mainSideEffects = createAgentMainSideEffects({
      upsertNotification: (notification) =>
        upsertResultNotification(resultNotificationsPath(), notification),
      markNotificationRead: (id, readAt) =>
        markResultNotificationRead(resultNotificationsPath(), id, readAt),
      broadcastNotifications: broadcastResultNotifications,
      showNativeNotification: showNativeResultNotificationIfNeeded,
      resolveProjectName: async (projectPath) => (await loadNovelProjectSummary(projectPath)).title,
      clearPendingMemorySync,
      onChapterWriteEvent: (event) => void recordChapterWrite(event),
      // 常驻润色（ADR-0041 §8）：写完一章、记忆已入库之后，App 层追加的那一步。
      // 完全旁路——失败只落进本章的「已跳过」留痕，绝不回头影响写作链路。
      onChapterWriteCompleted: ({ projectPath, startedAt, finishedAt }) => {
        void runStandingPolish(projectPath, {
          polishOnce: (input) => createHeadlessPolishRunManager().polishChapterOnce(input),
          openMemoryDb: openMemoryDbReadonly,
          withProjectLock: runProjectMutation,
          hasFreshManuscript: async (path, chapter) => {
            const list = await manuscriptRevisionStore
              .listChapter({ projectPath: path, chapter })
              .catch(() => null)
            if (!list) return false
            return hasAgentWriteWithinRun(list.revisions, { startedAt, finishedAt })
          },
        })
          .then((result) => {
            // 后台跑完必须主动通知渲染端：它不属于任何一次 IPC 调用，不广播的话正文页会一直
            // 停在原稿上，连「已润色 / 已跳过」的横幅都看不到。
            if (result.status === 'off') return
            broadcastPolishEvent({ type: 'standing-finished', chapter: result.chapter, status: result.status })
          })
          .catch((error) => console.error('[polish] 常驻润色失败', error))
      },
    })
    _agentRuntimeCoordinator = createAgentRuntimeCoordinator({
      store,
      resolveProjectIdentity: async (projectPath) => {
        const summary = await loadNovelProjectSummary(projectPath)
        return { id: summary.id, path: summary.path }
      },
      createRunManager: (sendEvent, sessionLifecycle) =>
        createAgentRunManager({
          readConfig: readCurrentConfig,
          getApiKey,
          sendEvent,
          appRoot: app.getAppPath(),
          resourcesPath: process.resourcesPath,
          enableAuthorSkillOverrides: true,
          userDataPath: userDataPath(),
          createSessionFingerprint: async (input) => {
            const project = input.projectPath
              ? await loadNovelProjectSummary(input.projectPath).catch(() => undefined)
              : undefined
            return createAgentSessionCompatibilityFingerprint({
              ...input,
              projectId: project?.id,
              agentCoreVersion: NARRACAT_AGENT_CORE_VERSION_LOCK.version,
            })
          },
          onSessionContextEstablished: sessionLifecycle.established,
          onSessionInvalidated: sessionLifecycle.invalidated,
          manuscriptRevisionStore,
        }),
      onSideEffectError: (error) => console.error(error),
      beforeBroadcast: mainSideEffects,
      // 路径取证的已知根之一（#37）：引擎目录在开发机上同样落在用户目录下，
      // 不传根就会被脱敏整段抹成 `[本机路径]`，引擎侧的读取失败照样查不了。
      agentCorePath: resolveNarraCatAgentCorePath({
        appRoot: app.getAppPath(),
        resourcesPath: process.resourcesPath,
      }),
    })
  }
  return _agentRuntimeCoordinator
}

export function runProjectMutation<T>(projectPath: string, operation: () => Promise<T>): Promise<T> {
  return getAgentRuntimeCoordinator().runProjectMutation(projectPath, operation)
}

function subscribeAgentRuntimeSender(sender: Electron.WebContents): void {
  if (agentRuntimeUnsubscribers.has(sender)) return
  const unsubscribe = getAgentRuntimeCoordinator().subscribe({
    id: String(sender.id),
    send: (envelope) => {
      if (!sender.isDestroyed()) sender.send('agent:event', envelope)
    },
  })
  agentRuntimeUnsubscribers.set(sender, unsubscribe)
  sender.once('destroyed', () => {
    unsubscribe()
    agentRuntimeUnsubscribers.delete(sender)
  })
}

export function reconcileAgentRuntimeStartup(): Promise<number> {
  return getAgentRuntimeCoordinator().reconcileStartup()
}

export function settleAgentRuntimeBeforeQuit(): Promise<void> {
  return getAgentRuntimeCoordinator().interruptAllForQuit()
}

export function hasActiveAgentRuntimeRuns(): boolean {
  return getAgentRuntimeCoordinator().hasActiveRuns()
}

export async function invalidateAgentSessions(reason: string): Promise<void> {
  await getAgentRuntimeCoordinator().invalidateAllSessions(reason)
}

export function registerAgentIpcHandlers(): void {
  ipcMain.handle('agent:start-run', async (event, input: unknown): Promise<AgentRunStarted> => {
    const request = normalizeAgentRunRequest(input)
    subscribeAgentRuntimeSender(event.sender)
    return getAgentRuntimeCoordinator().startRun({
      ...request,
      requestId: request.requestId ?? randomUUID(),
    })
  })

  ipcMain.handle('agent:cancel-run', async (event, input: unknown): Promise<{ cancelled: boolean }> => {
    subscribeAgentRuntimeSender(event.sender)
    return getAgentRuntimeCoordinator().cancelRun(normalizeAgentCancelRun(input))
  })

  ipcMain.handle('agent:answer-question', async (event, input: unknown): Promise<{ accepted: boolean }> => {
    subscribeAgentRuntimeSender(event.sender)
    return getAgentRuntimeCoordinator().answerQuestion(normalizeAgentQuestionAnswer(input))
  })

  ipcMain.handle('agent:forget-session', async (event, input: unknown): Promise<void> => {
    subscribeAgentRuntimeSender(event.sender)
    if (typeof input === 'string' && input.trim()) {
      await getAgentRuntimeCoordinator().forgetThreadSession({ threadId: input.trim(), requestId: input.trim() })
      return
    }
    const value = readInputRecord(input, 'Agent 会话参数非法。')
    await getAgentRuntimeCoordinator().forgetThreadSession({
      threadId: readRequiredString(value, 'threadId', '缺少 Agent threadId。'),
      requestId: readRequiredString(value, 'requestId', '缺少 requestId。'),
    })
  })

  ipcMain.handle(
    'agent:get-thread-snapshot',
    async (event, input: unknown): Promise<AgentThreadSnapshotV1> => {
      const value = readInputRecord(input, 'Agent 历史参数非法。')
      const threadId = readRequiredString(value, 'threadId', '缺少 Agent threadId。')
      const segmentId = readOptionalString(value, 'segmentId', 'Agent segmentId 参数非法。')
      subscribeAgentRuntimeSender(event.sender)
      return getAgentRuntimeCoordinator().getThreadSnapshot(threadId, segmentId)
    },
  )

  ipcMain.handle(
    'agent:get-events-after',
    async (_event, input: unknown): Promise<AgentEventsAfterResultV1> => {
      const value = readInputRecord(input, 'Agent 事件补放参数非法。')
      const threadId = readRequiredString(value, 'threadId', '缺少 Agent threadId。')
      const segmentId = readRequiredString(value, 'segmentId', '缺少 Agent segmentId。')
      if (typeof value.afterSeq !== 'number' || !Number.isSafeInteger(value.afterSeq) || value.afterSeq < 0) {
        throw new Error('Agent afterSeq 参数非法。')
      }
      return getAgentRuntimeCoordinator().getEventsAfter(threadId, segmentId, value.afterSeq)
    },
  )

  ipcMain.handle(
    'agent:list-history-segments',
    async (_event, threadId: unknown): Promise<AgentHistorySegmentSummaryV1[]> => {
      if (typeof threadId !== 'string' || !threadId.trim()) throw new Error('Agent threadId 参数非法。')
      return getAgentRuntimeCoordinator().listHistorySegments(threadId)
    },
  )

  ipcMain.handle(
    'agent:start-new-conversation',
    async (event, input: unknown): Promise<AgentThreadSnapshotV1> => {
      const value = readInputRecord(input, '开始新对话参数非法。')
      const request: AgentStartNewConversationInput = {
        threadId: readRequiredString(value, 'threadId', '缺少 Agent threadId。'),
        requestId: readRequiredString(value, 'requestId', '缺少 requestId。'),
      }
      subscribeAgentRuntimeSender(event.sender)
      return getAgentRuntimeCoordinator().startNewConversation(request)
    },
  )
}
