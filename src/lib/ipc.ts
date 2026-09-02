// 渲染端 IPC client（typed wrapper over window.electron）
// 让组件不直接 touch window.electron，方便未来加错误处理 / mock
import type {
  PolishAdoptOutcome,
  PolishAdoptRequest,
  PolishRecipeFile,
  PolishRunEvent,
  PolishRunRequest,
  PolishSlotId,
  PolishVersionState,
  ProjectPolishSettings,
} from '@shared/types/prose-polish'
import type {
  AgentEventEnvelopeV1,
  AgentEventsAfterResultV1,
  AgentHistorySegmentSummaryV1,
  AgentRunRequest,
  AgentRunStarted,
  AgentStartNewConversationInput,
  AgentThreadSnapshotV1,
  AppConfig,
  AppConfigPayload,
  CharacterChatProfiles,
  CharacterChatSendRequest,
  CharacterChatStreamEvent,
  CharacterChatTranscript,
  CharacterChatUserMode,
  CharacterContactList,
  ConnectionTestResult,
  CorpusHealthProbeResult,
  CreatedNovelProject,
  CreateNovelProjectBackupDialogResult,
  CreateNovelProjectInput,
  DeleteNovelProjectInput,
  DeleteNovelProjectResult,
  ElectronApi,
  NarraCatAgentCoreDiagnostics,
  NovelChapterArtifacts,
  NovelProjectDetail,
  NovelProjectSummary,
  RememberNovelProjectPathInput,
  NovelStatusSnapshot,
  NovelWorkbenchArtifacts,
  PasteReferenceSourceInput,
  PremiseEditResult,
  AuthoredStateEditInput,
  ChapterOutlineFieldEditInput,
  CharacterIdentityEditInput,
  MasterOutlineFieldEditInput,
  ManuscriptEditInput,
  ManuscriptDraftInput,
  ManuscriptDraftState,
  ManuscriptDraftSummary,
  ManuscriptSaveResult,
  ManuscriptRevisionContent,
  ManuscriptRevisionInput,
  ManuscriptRevisionList,
  ReadManuscriptRevisionInput,
  RestoreManuscriptRevisionInput,
  RestoreNovelProjectBackupDialogResult,
  PendingMemorySyncEntry,
  PremiseFieldEditInput,
  ProviderId,
  ProviderModelListResult,
  ReferenceWorksSummary,
  RemoveReferenceSourceInput,
  ResolvePlannedStateInput,
  UpdateChapterStateChangesInput,
  UpdateNovelProjectMetadataInput,
  ResultNotification,
  ResultNotificationList,
  EmbeddingHealthProbeResult,
  ReleaseGateVerdict,
  SaveManuscriptDraftInput,
  StoredWorkLocation,
  UpdaterState,
} from '@shared/types/ipc'
import type { AgentQuestionAnswer } from '@/types/agent'
import type { AuthorRequest } from '@shared/types/author-request'
import type { CharacterStateSnapshot } from '@shared/types/character-state'
import type { MemoryGraphSnapshot } from '@shared/types/memory-graph'
import type {
  PlannedStateCounts,
  PlannedStateReadResult,
  ReadPlannedStateCountsInput,
  ReadPlannedStateInput,
} from '@shared/types/planned-state'
import type { ProseBlockView } from '@shared/types/prose-block'
import type { ProcessHealthReport } from '@shared/types/process-health'
import type { TelemetryState } from '@shared/types/telemetry'

export function ping(): Promise<string> {
  return window.electron.ping()
}

export function checkReleaseGuard(): Promise<ReleaseGateVerdict> {
  return window.electron.checkReleaseGuard()
}

export function getTelemetryState(): Promise<TelemetryState> {
  return window.electron.getTelemetryState()
}

export function setTelemetryEnabled(enabled: boolean): Promise<TelemetryState> {
  return window.electron.setTelemetryEnabled(enabled)
}

export function acknowledgeTelemetryNotice(): Promise<TelemetryState> {
  return window.electron.acknowledgeTelemetryNotice()
}

export function resetTelemetryAnonymousId(): Promise<TelemetryState> {
  return window.electron.resetTelemetryAnonymousId()
}

export function revealTelemetryQueue(): Promise<void> {
  return window.electron.revealTelemetryQueue()
}

export function getUpdaterState(): Promise<UpdaterState> {
  return window.electron.getUpdaterState()
}

export function checkForUpdates(): Promise<void> {
  return window.electron.checkForUpdates()
}

export function installUpdate(): Promise<void> {
  return window.electron.installUpdate()
}

export function onUpdaterStateChanged(callback: (state: UpdaterState) => void): () => void {
  return window.electron.onUpdaterStateChanged(callback)
}

export function getConfig(): Promise<AppConfigPayload> {
  return window.electron.getConfig()
}

export function saveConfig(config: AppConfig): Promise<AppConfigPayload> {
  return window.electron.saveConfig(config)
}

export function setPrimaryModel(key: string): Promise<AppConfigPayload> {
  return window.electron.setPrimaryModel(key)
}

export function setApiKey(provider: ProviderId, apiKey: string): Promise<{ hasApiKey: boolean }> {
  return window.electron.setApiKey(provider, apiKey)
}

export function deleteApiKey(provider: ProviderId): Promise<{ hasApiKey: boolean }> {
  return window.electron.deleteApiKey(provider)
}

export function hasApiKey(provider: ProviderId): Promise<{ hasApiKey: boolean }> {
  return window.electron.hasApiKey(provider)
}

export function testConnection(provider: ProviderId): Promise<ConnectionTestResult> {
  return window.electron.testConnection(provider)
}

export function listProviderModels(provider: ProviderId): Promise<ProviderModelListResult> {
  return window.electron.listProviderModels(provider)
}

export function getNarraCatDiagnostics(): Promise<NarraCatAgentCoreDiagnostics> {
  return window.electron.getNarraCatDiagnostics()
}

/** 进程健康记录（#39）：界面崩溃 / 子进程退出 / 主线程卡死的留痕。 */
export function getProcessHealth(): Promise<ProcessHealthReport> {
  return window.electron.getProcessHealth()
}

/**
 * 读官方 Skill 正文（详情弹窗展示，只读可见——ADR-0020 约束 1 的「不可查看」半条已推翻）；
 * 读失败主进程降级返回空串，不抛。
 */
export function readOfficialSkillBody(input: { skillId: string }): Promise<string> {
  return window.electron.readOfficialSkillBody(input)
}

export function listAuthorRequests(input: { agentId: string }): Promise<AuthorRequest[]> {
  return window.electron.listAuthorRequests(input)
}

export function addAuthorRequest(input: { agentId: string; text: string }): Promise<AuthorRequest[]> {
  return window.electron.addAuthorRequest(input)
}

export function updateAuthorRequest(input: { agentId: string; id: string; text: string }): Promise<AuthorRequest[]> {
  return window.electron.updateAuthorRequest(input)
}

export function removeAuthorRequest(input: { agentId: string; id: string }): Promise<AuthorRequest[]> {
  return window.electron.removeAuthorRequest(input)
}

/** 读某 Agent 的散文块当前状态（当前生效正文 = userText ?? officialText），供预算展示等只读消费。 */
export function listProseBlocks(input: { agentId: string }): Promise<ProseBlockView[]> {
  return window.electron.listProseBlocks(input)
}

export function runEmbeddingHealthProbe(): Promise<EmbeddingHealthProbeResult> {
  return window.electron.runEmbeddingHealthProbe()
}

export function runCorpusHealthProbe(): Promise<CorpusHealthProbeResult> {
  return window.electron.runCorpusHealthProbe()
}

export function listResultNotifications(): Promise<ResultNotificationList> {
  return window.electron.listResultNotifications()
}

export function upsertResultNotification(notification: ResultNotification): Promise<ResultNotificationList> {
  return window.electron.upsertResultNotification(notification)
}

export function markResultNotificationRead(id: string): Promise<ResultNotificationList> {
  return window.electron.markResultNotificationRead(id)
}

export function markAllResultNotificationsRead(): Promise<ResultNotificationList> {
  return window.electron.markAllResultNotificationsRead()
}

export function readWorkLocation(): Promise<StoredWorkLocation> {
  return window.electron.readWorkLocation()
}

export function writeWorkLocation(location: StoredWorkLocation): Promise<void> {
  return window.electron.writeWorkLocation(location)
}

export function listNovelProjects(): Promise<NovelProjectSummary[]> {
  return window.electron.listNovelProjects()
}

export function createNovelProjectBackup(
  projectPath: string,
): Promise<CreateNovelProjectBackupDialogResult> {
  return window.electron.createNovelProjectBackup(projectPath)
}

export function restoreNovelProjectBackup(): Promise<RestoreNovelProjectBackupDialogResult> {
  return window.electron.restoreNovelProjectBackup()
}

export function rememberNovelProjectPath(input: RememberNovelProjectPathInput): Promise<{ updated: boolean }> {
  return window.electron.rememberNovelProjectPath(input)
}

export function createNovelProject(input: CreateNovelProjectInput): Promise<CreatedNovelProject> {
  return window.electron.createNovelProject(input)
}

export function updateNovelProjectMetadata(input: UpdateNovelProjectMetadataInput): Promise<NovelProjectDetail> {
  return window.electron.updateNovelProjectMetadata(input)
}

export function deleteNovelProject(input: DeleteNovelProjectInput): Promise<DeleteNovelProjectResult> {
  return window.electron.deleteNovelProject(input)
}

export function getNovelProject(projectPath: string, selectedChapter?: number): Promise<NovelProjectDetail> {
  return window.electron.getNovelProject(projectPath, selectedChapter)
}

export function readNovelStatus(projectPath: string): Promise<NovelStatusSnapshot | null> {
  return window.electron.readNovelStatus(projectPath)
}

export function refreshNovelStatus(projectPath: string): Promise<NovelStatusSnapshot> {
  return window.electron.refreshNovelStatus(projectPath)
}

export function listAppearedCharacters(projectPath: string): Promise<CharacterContactList> {
  return window.electron.listAppearedCharacters(projectPath)
}

export function readCharacterState(input: {
  projectPath: string
  characterUid: string
  characterName: string
}): Promise<CharacterStateSnapshot> {
  return window.electron.readCharacterState(input)
}

export function readPlannedState(input: ReadPlannedStateInput): Promise<PlannedStateReadResult> {
  return window.electron.readPlannedState(input)
}

export function readPlannedStateCounts(input: ReadPlannedStateCountsInput): Promise<PlannedStateCounts> {
  return window.electron.readPlannedStateCounts(input)
}

export function readMemoryGraph(input: { projectPath: string }): Promise<MemoryGraphSnapshot> {
  return window.electron.readMemoryGraph(input)
}

export function enrichCharacterStatuses(input: {
  projectPath: string
  characterUids: string[]
  knowledgeBoundaryChapter: number | null
}): Promise<Record<string, string>> {
  return window.electron.enrichCharacterStatuses(input)
}

export function getNovelChapterArtifacts(
  projectPath: string,
  chapterNumber: number,
  volumeNumber?: number,
): Promise<NovelChapterArtifacts> {
  return window.electron.getNovelChapterArtifacts(projectPath, chapterNumber, volumeNumber)
}

export function getNovelWorkbenchArtifacts(
  projectPath: string,
  objectId: string,
  volumeNumber?: number,
): Promise<NovelWorkbenchArtifacts> {
  return window.electron.getNovelWorkbenchArtifacts(projectPath, objectId, volumeNumber)
}

export function submitPremiseFieldEdit(input: PremiseFieldEditInput): Promise<PremiseEditResult> {
  return window.electron.submitPremiseFieldEdit(input)
}

export function submitChapterOutlineFieldEdit(input: ChapterOutlineFieldEditInput): Promise<{ ok: boolean; message?: string }> {
  return window.electron.submitChapterOutlineFieldEdit(input)
}

export function submitMasterOutlineFieldEdit(input: MasterOutlineFieldEditInput): Promise<{ ok: boolean; message?: string }> {
  return window.electron.submitMasterOutlineFieldEdit(input)
}

export function submitAuthoredState(input: AuthoredStateEditInput): Promise<{ ok: boolean; message?: string }> {
  return window.electron.submitAuthoredState(input)
}

export function resolvePlannedState(input: ResolvePlannedStateInput): Promise<{ ok: boolean; message?: string }> {
  return window.electron.resolvePlannedState(input)
}

export function updateChapterStateChanges(input: UpdateChapterStateChangesInput): Promise<{ ok: boolean; message?: string }> {
  return window.electron.updateChapterStateChanges(input)
}

export function submitCharacterIdentity(input: CharacterIdentityEditInput): Promise<{ ok: boolean; message?: string }> {
  return window.electron.submitCharacterIdentity(input)
}

export function saveChapterManuscript(input: ManuscriptEditInput): Promise<ManuscriptSaveResult> {
  return window.electron.saveChapterManuscript(input)
}

export function listManuscriptRevisions(input: ManuscriptRevisionInput): Promise<ManuscriptRevisionList> {
  return window.electron.listManuscriptRevisions(input)
}

export function readManuscriptRevision(input: ReadManuscriptRevisionInput): Promise<ManuscriptRevisionContent> {
  return window.electron.readManuscriptRevision(input)
}

export function restoreManuscriptRevision(input: RestoreManuscriptRevisionInput): Promise<ManuscriptSaveResult> {
  return window.electron.restoreManuscriptRevision(input)
}

export function submitStyleAnchor(input: Parameters<ElectronApi['submitStyleAnchor']>[0]) {
  return window.electron.submitStyleAnchor(input)
}

export function listStyleAnchors(input: Parameters<ElectronApi['listStyleAnchors']>[0]) {
  return window.electron.listStyleAnchors(input)
}

export function getManuscriptDraft(input: ManuscriptDraftInput): Promise<ManuscriptDraftState> {
  return window.electron.getManuscriptDraft(input)
}

export function saveManuscriptDraft(input: SaveManuscriptDraftInput): Promise<{ ok: true }> {
  return window.electron.saveManuscriptDraft(input)
}

export function discardManuscriptDraft(input: ManuscriptDraftInput): Promise<{ ok: true }> {
  return window.electron.discardManuscriptDraft(input)
}

export function listManuscriptDrafts(projectPath: string): Promise<ManuscriptDraftSummary[]> {
  return window.electron.listManuscriptDrafts(projectPath)
}

export function getPendingMemorySync(projectPath: string): Promise<Record<string, PendingMemorySyncEntry>> {
  return window.electron.getPendingMemorySync(projectPath)
}

export function clearPendingMemorySync(projectPath: string, chapter: number): Promise<{ ok: boolean }> {
  return window.electron.clearPendingMemorySync({ projectPath, chapter })
}

export function pasteReferenceSource(input: PasteReferenceSourceInput): Promise<ReferenceWorksSummary> {
  return window.electron.pasteReferenceSource(input)
}

export function importReferenceSourceFiles(projectPath: string): Promise<ReferenceWorksSummary> {
  return window.electron.importReferenceSourceFiles(projectPath)
}

export function removeReferenceSource(input: RemoveReferenceSourceInput): Promise<ReferenceWorksSummary> {
  return window.electron.removeReferenceSource(input)
}

export function clearReferenceGuidance(projectPath: string): Promise<ReferenceWorksSummary> {
  return window.electron.clearReferenceGuidance(projectPath)
}

export function resetReferenceWorks(projectPath: string): Promise<ReferenceWorksSummary> {
  return window.electron.resetReferenceWorks(projectPath)
}

export function selectDirectory(): Promise<string | null> {
  return window.electron.selectDirectory()
}

export function startAgentRun(request: AgentRunRequest): Promise<AgentRunStarted> {
  return window.electron.startAgentRun({ ...request, requestId: request.requestId ?? crypto.randomUUID() })
}

export function cancelAgentRun(runId: string): Promise<{ cancelled: boolean }> {
  return window.electron.cancelAgentRun({ runId, requestId: crypto.randomUUID() })
}

export function answerAgentQuestion(answer: AgentQuestionAnswer): Promise<{ accepted: boolean }> {
  return window.electron.answerAgentQuestion({
    requestId: crypto.randomUUID(),
    questionRequestId: answer.requestId,
    answers: answer.answers,
  }).then((result) => {
    if (!result.accepted) {
      throw new Error('问题已过期或当前运行已结束。')
    }

    return result
  })
}

export function forgetAgentSession(threadId: string): Promise<void> {
  return window.electron.forgetAgentSession({ threadId, requestId: crypto.randomUUID() })
}

export function getAgentThreadSnapshot(
  threadId: string,
  segmentId?: string,
): Promise<AgentThreadSnapshotV1> {
  return window.electron.getAgentThreadSnapshot({ threadId, segmentId })
}

export function getAgentEventsAfter(
  threadId: string,
  segmentId: string,
  afterSeq: number,
): Promise<AgentEventsAfterResultV1> {
  return window.electron.getAgentEventsAfter({ threadId, segmentId, afterSeq })
}

export function listAgentHistorySegments(threadId: string): Promise<AgentHistorySegmentSummaryV1[]> {
  return window.electron.listAgentHistorySegments(threadId)
}

export function startNewAgentConversation(
  input: AgentStartNewConversationInput,
): Promise<AgentThreadSnapshotV1> {
  return window.electron.startNewAgentConversation(input)
}

export function onAgentEvent(callback: (event: AgentEventEnvelopeV1) => void): () => void {
  return window.electron.onAgentEvent(callback)
}

export function sendCharacterChatMessage(request: CharacterChatSendRequest): Promise<{ runId: string }> {
  return window.electron.sendCharacterChatMessage(request)
}

export function cancelCharacterChat(runId: string): Promise<{ cancelled: boolean }> {
  return window.electron.cancelCharacterChat(runId)
}

export function onCharacterChatEvent(callback: (event: CharacterChatStreamEvent) => void): () => void {
  return window.electron.onCharacterChatEvent(callback)
}

export function readCharacterChatTranscript(input: {
  projectPath: string
  characterUid: string
  userMode: CharacterChatUserMode
}): Promise<CharacterChatTranscript> {
  return window.electron.readCharacterChatTranscript(input)
}

export function saveCharacterChatTranscript(input: {
  projectPath: string
  characterUid: string
  userMode: CharacterChatUserMode
  messages: CharacterChatTranscript['messages']
}): Promise<CharacterChatTranscript> {
  return window.electron.saveCharacterChatTranscript(input)
}

export function readCharacterChatProfiles(input: {
  projectPath: string
  characterUid: string
}): Promise<CharacterChatProfiles> {
  return window.electron.readCharacterChatProfiles(input)
}

export function saveCharacterChatProfile(input: {
  scope: 'author' | 'impression'
  content: string
  projectPath: string
  characterUid: string
}): Promise<void> {
  return window.electron.saveCharacterChatProfile(input)
}

export function flushCharacterChatProfile(input: {
  projectPath: string
  characterUid: string
  characterName: string
}): Promise<void> {
  return window.electron.flushCharacterChatProfile(input)
}

export function onOpenResultNotification(callback: (notification: ResultNotification) => void): () => void {
  return window.electron.onOpenResultNotification(callback)
}

export function onResultNotificationsChanged(callback: (event: ResultNotificationList) => void): () => void {
  return window.electron.onResultNotificationsChanged(callback)
}

// --- 正文润色（ADR-0041）------------------------------------------------------

export function listPolishRecipes(): Promise<PolishRecipeFile> {
  return window.electron.listPolishRecipes()
}

export function savePolishRecipe(input: {
  slotId: PolishSlotId
  prompt: string
  modelKey: string | null
  thinking: boolean
}): Promise<PolishRecipeFile> {
  return window.electron.savePolishRecipe(input)
}

export function getPolishSettings(projectPath: string): Promise<ProjectPolishSettings> {
  return window.electron.getPolishSettings({ projectPath })
}

export function setStandingPolishSlot(input: {
  projectPath: string
  slotId: PolishSlotId | null
}): Promise<ProjectPolishSettings> {
  return window.electron.setStandingPolishSlot(input)
}

export function startPolishRun(
  input: PolishRunRequest,
): Promise<{ runId: string; versions: PolishVersionState[] }> {
  return window.electron.startPolishRun(input)
}

export function cancelPolishRun(input: { runId: string; slotId?: PolishSlotId }): Promise<{ cancelled: boolean }> {
  return window.electron.cancelPolishRun(input)
}

export function adoptPolishedChapter(
  input: PolishAdoptRequest,
): Promise<
  | { ok: true; outcome: PolishAdoptOutcome }
  | { ok: false; conflict?: boolean; needsDivergenceAck?: boolean; message: string }
> {
  return window.electron.adoptPolishedChapter(input)
}

export function clearStandingPolishOutcome(input: {
  projectPath: string
  chapter: number
}): Promise<ProjectPolishSettings> {
  return window.electron.clearStandingPolishOutcome(input)
}

export function markStandingPromptAnswered(projectPath: string): Promise<ProjectPolishSettings> {
  return window.electron.markStandingPromptAnswered({ projectPath })
}

export function onPolishEvent(callback: (event: PolishRunEvent) => void): () => void {
  return window.electron.onPolishEvent(callback)
}
