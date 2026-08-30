// 渲染端可以用的 window.electron API 类型声明。
// 实际实现在 electron/preload/index.cts。

import type { AppConfig, ProviderId } from './config'
import type { MemoryGraphSnapshot } from './memory-graph'
import type { CardLintFinding } from '@shared/lib/capability-pack-lint'
import type {
  AgentEventEnvelopeV1,
  AgentEventsAfterResultV1,
  AgentHistorySegmentSummaryV1,
  AgentStartNewConversationInput,
  AgentThreadSnapshotV1,
} from './agent'
import type { AgentRunRequest, AgentRunStarted } from './agent-run'
import type {
  CorpusHealthProbeResult,
  EmbeddingHealthProbeResult,
  NarraCatAgentCoreDiagnostics,
} from './narracat'
import type { ProseBlockView } from './prose-block'
import type { TelemetryState } from './telemetry'
import type { AuthorRequest } from './author-request'
import type {
  CapabilityPackSummary,
  ChapterCapabilityReceiptData,
  CompiledCardMeta,
  DraftCard,
  ExportPackDraftProjectResult,
  ExportPackResult,
  ImportPackDraftProjectResult,
  ImportPackResult,
  LocalPackContent,
  NovelPacksEntry,
  PackDetailResult,
  PackDraftMeta,
  PackLearnEstimate,
  PackLearnEvent,
  PackLearnResult,
  PackLearnSource,
  PackLearnTier,
  PackLicense,
  PackWizardAck,
  PackWizardEvent,
  PackWizardSnapshot,
  PlanningCapabilityReceiptData,
  PreviewImportPackResult,
} from './capability-pack'
import type { ResultNotification, ResultNotificationList } from './notifications'
import type { ReleaseGateVerdict } from './release-guard'
import type { CharacterStateSnapshot } from './character-state'
import type {
  PlannedStateCounts,
  PlannedStateReadResult,
  ReadPlannedStateCountsInput,
  ReadPlannedStateInput,
} from './planned-state'
import type {
  CharacterContactList,
  CharacterChatProfiles,
  CharacterChatSendRequest,
  CharacterChatStreamEvent,
  CharacterChatTranscript,
  CharacterChatUserMode,
} from './character-chat'
import type {
  ManuscriptDraftInput,
  ManuscriptDraftState,
  ManuscriptDraftSummary,
  SaveManuscriptDraftInput,
} from './manuscript-draft'
import type {
  ManuscriptRevisionContent,
  ManuscriptRevisionInput,
  ManuscriptRevisionList,
  ReadManuscriptRevisionInput,
  RestoreManuscriptRevisionInput,
} from './manuscript-revision'
import type {
  CreatedNovelProject,
  CreateNovelProjectInput,
  DeleteNovelProjectInput,
  DeleteNovelProjectResult,
  NovelChapterArtifacts,
  NovelProjectDetail,
  NovelProjectSummary,
  NovelStatusSnapshot,
  NovelWorkbenchArtifacts,
  PasteReferenceSourceInput,
  ReferenceWorksSummary,
  RememberNovelProjectPathInput,
  RemoveReferenceSourceInput,
  UpdateNovelProjectMetadataInput,
} from './novel'
import type { StoredWorkLocation } from './work-location'
import type {
  CreateNovelProjectBackupDialogResult,
  RestoreNovelProjectBackupDialogResult,
} from './project-backup'
import type { UpdaterState } from './updater'
import type { ProcessHealthReport } from './process-health'
export type { AppConfig, ModelPoolEntry, ProviderId } from './config'
export type {
  AgentEvent,
  AgentEventEnvelopeV1,
  AgentEventsAfterResultV1,
  AgentHistorySegmentSummaryV1,
  AgentQuickAction,
  AgentRunTarget,
  AgentStartNewConversationInput,
  AgentThreadSnapshotV1,
} from './agent'
export type { AgentRunRequest, AgentRunStarted } from './agent-run'
export type {
  CorpusHealthProbeResult,
  EmbeddingHealthProbeResult,
  EmbeddingModelSource,
  EmbeddingSelfTestReport,
  NarraCatAgentCoreDiagnostics,
} from './narracat'
export type { AuthorRequest } from './author-request'
export type {
  CreateNovelProjectBackupDialogResult,
  NovelProjectBackupManifest,
  NovelProjectBackupPackDependency,
  RestoreNovelProjectBackupDialogResult,
} from './project-backup'
export type {
  CapabilityPackSummary,
  ChapterCapabilityReceiptData,
  ChapterCapabilityReceiptEntry,
  CompiledCardMeta,
  DraftCard,
  ExportPackDraftProjectResult,
  ExportPackResult,
  ImportPackDraftProjectResult,
  ImportPackResult,
  LocalPackContent,
  NovelPacksEntry,
  PackDraftMeta,
  PackLearnEstimate,
  PackLearnEvent,
  PackLearnResult,
  PackLearnSource,
  PackLearnTier,
  PackLocalSource,
  PackWizardAck,
  PackWizardEvent,
  PackWizardMessage,
  PackWizardPhase,
  PackWizardSnapshot,
  PlanningCapabilityReceiptData,
  PlanningCapabilityReceiptEntry,
} from './capability-pack'
export type { ResultNotification, ResultNotificationList } from './notifications'
export type { StoredWorkLocation } from './work-location'
export type { ReleaseGateConfig, ReleaseGateReason, ReleaseGateVerdict } from './release-guard'
export type { UpdaterEvent, UpdaterState, UpdaterStatus } from './updater'
export type {
  CharacterContact,
  CharacterContactList,
  CharacterChatProfiles,
  CharacterChatUserMode,
  CharacterChatMessage,
  CharacterChatMessageStatus,
  CharacterChatRole,
  CharacterChatTranscript,
  CharacterChatSendRequest,
  CharacterChatStreamEvent,
} from './character-chat'
export type {
  ManuscriptDraftInput,
  ManuscriptDraftState,
  ManuscriptDraftSummary,
  SaveManuscriptDraftInput,
} from './manuscript-draft'
export type {
  ManuscriptRevisionContent,
  ManuscriptRevisionEntry,
  ManuscriptRevisionInput,
  ManuscriptRevisionList,
  ManuscriptRevisionSource,
  ManuscriptRevisionSummary,
  ReadManuscriptRevisionInput,
  RestoreManuscriptRevisionInput,
} from './manuscript-revision'
export type {
  CreatedNovelProject,
  CreateNovelProjectInput,
  DeleteNovelProjectInput,
  DeleteNovelProjectResult,
  NovelChapterArtifacts,
  NovelProjectDetail,
  NovelProjectSummary,
  RememberNovelProjectPathInput,
  NovelStatusSnapshot,
  NovelWorkbenchArtifacts,
  PasteReferenceSourceInput,
  ReferenceWorksSummary,
  RemoveReferenceSourceInput,
  UpdateNovelProjectMetadataInput,
} from './novel'

export interface AppConfigPayload {
  config: AppConfig
  hasApiKey: boolean
}

export interface ConnectionTestResult {
  ok: boolean
  message: string
  model?: string
  verifiedAt?: string
}

/** `provider:list-models` 渠道模型清单拉取结果——失败一律收敛为 ok:false，UI 静默回落内置目录。 */
export type ProviderModelListResult = { ok: true; models: string[] } | { ok: false; message: string }

/**
 * 立项卡就地编辑：支持两类操作（discriminated union by `kind`）：
 * - mark-canon：纯信心转移（暂定 → 已定，内容不变）
 * - edit-content：改内容，仅限第一档纯描述字段（ADR-0029）
 * 内容修改与其它状态流转一律经 Agent 的 /revise-premise（ADR-0019 2026-06-15(2)）。
 */
interface PremiseEditLock {
  projectPath: string
  cardKey: string
  /** 该卡 fields 数组内的位置 */
  fieldIndex: number
  /** 乐观锁——渲染时该字段的 key / value（已 trim）/ 确定度；main 读盘后不符则拒绝并要求刷新 */
  expectedKey: string
  expectedValue: string
  expectedCertainty: string
}
export type PremiseFieldEditInput =
  | (PremiseEditLock & { kind: 'mark-canon'; certainty: 'canon' })
  | (PremiseEditLock & { kind: 'edit-content'; newValue: string })

export interface PremiseEditResult {
  ok: boolean
  errors?: Array<{ field?: string; expected?: string; actual?: string; hint?: string }>
  message?: string
}

export interface ChapterOutlineFieldEditInput {
  projectPath: string
  chapter: number
  fieldKey: string
  newValue: string
  expectedOldValue: string
  /** 新格式（beat 骨架）数组字段的元素下标；缺省 = 标量字段整体替换 */
  itemIndex?: number
}

export interface MasterOutlineFieldEditInput {
  projectPath: string
  target: 'stakes_progression' | 'storyline_name' | 'foreshadowing_description'
  id?: string
  newValue: string
  expectedOldValue: string
}

/** 角色状态第一档直存（A4×D2 片2b）——payload 镜像引擎 authored-state.json schema，字段语义见该 schema */
export interface AuthoredStateEditInput {
  projectPath: string
  payload: {
    character_uid: string
    action: 'set_current' | 'backfill' | 'correct' | 'retract' | 'endorse' | 'mark_secret_known'
    dimension?: string
    operation?: 'set' | 'add' | 'remove'
    value?: string
    effective_chapter?: number
    target_fact_id?: string
    new_value?: string
    new_event_chapter?: number
    /** set_current 乐观锁：该维度当前有效最新值不符则引擎拒绝 */
    expected_current_value?: string
    /** mark_secret_known 专用：true=本人已知晓，false=撤销标记 */
    known?: boolean
    /** set_current/backfill 提交 secret 谓词维度时顺手声明「本人已知晓」 */
    secret_known?: boolean
  }
}

/** 出生证编辑（性别/年龄/别名）；空串/空数组 = 清除该字段。改名本片不开。 */
export interface CharacterIdentityEditInput {
  projectPath: string
  characterUid: string
  characterName: string
  gender: string
  age: string
  aliases: string[]
}

/** 计划状态变更处置（兑现报告卡四动作，A4×D2 片3b）；defer 必带 to_chapter，其余动作不带。 */
export interface ResolvePlannedStateInput {
  projectPath: string
  payload: {
    id: string
    action: 'defer' | 'cancel' | 'acknowledge' | 'mark_delivered'
    to_chapter?: number
  }
}

/** 章纲卡 state_changes 整段替换（A4×D2 片3b）——payload 镜像引擎 chapter_outline.state_changes 契约。 */
export interface UpdateChapterStateChangesInput {
  projectPath: string
  payload: {
    chapter: number
    state_changes: Array<{
      character: { character_uid: string; name: string }
      dimension: string
      operation?: 'set' | 'add' | 'remove'
      value: string
      reason?: string
    }>
    /** 读取时快照（CAS 基线），原样回传 */
    expected_state_changes: unknown[]
  }
}

export interface ManuscriptEditInput {
  projectPath: string
  chapter: number
  expectedVisibleText: string
  newVisibleText: string
}

export interface ManuscriptSaveTriage {
  tier: 'silent' | 'impact'
  reasons: string[]
}

export type ManuscriptSaveResult =
  | { ok: true; triage: ManuscriptSaveTriage }
  | { ok: false; conflict?: boolean; message: string }

export interface PendingMemorySyncEntry {
  savedAt: string
  reasons: string[]
}

/** 小说级能力包启用清单（`.narracat/packs.json` 镜像，B2 刀1，ADR-0034 v1.1）。 */
export interface NovelPacksFile {
  format_version: 1
  enabled: NovelPacksEntry[]
}

/** 造包草稿卡意图编译结果（`packs:draft-compile` 通道，B2 刀3 Task 6/10）。 */
export type CompileDraftCardResult = { status: 'ok'; compiled: CompiledCardMeta } | { status: 'error'; message: string }

/** 造包草稿卡干跑预演结果（`packs:draft-preview` 通道，B2 刀3 Task 8/10）。 */
export type PreviewDraftCardResult =
  | { status: 'ok'; kind: 'craft' | 'persona'; results: Array<{ id: string; name: string; selected: boolean; reason: string }> }
  | { status: 'ok'; kind: 'structure'; stage: string }
  | { status: 'error'; message: string }

/** 造包草稿发布 lint 命中（`CardLintFinding` + 分级，与主进程 pack-publish.ts 的 PublishLintFinding 同形状）。 */
export interface DraftPublishLintFinding extends CardLintFinding {
  severity: 'block' | 'warn'
}

/** 造包草稿发布结果（`packs:draft-publish` 通道，B2 刀3 Task 7/10）。 */
export type PublishPackDraftResult =
  | { status: 'ok'; summary: CapabilityPackSummary }
  | { status: 'invalid'; errors: string[]; lintFindings: Array<{ cardId: string; findings: DraftPublishLintFinding[] }> }

export interface ElectronApi {
  /** 主进程平台标识（'win32' | 'darwin' | 'linux'），渲染端顶栏布局等平台感知逻辑用。 */
  platform: string
  /** Windows 标题栏 overlay 符号颜色跟随主题（mac/Linux 上为 no-op）。 */
  setTitleBarOverlaySymbolColor: (symbolColor: string) => Promise<void>
  ping: () => Promise<string>
  /** 进程健康记录（#39）：渲染进程崩溃 / 子进程崩溃 / 主线程挂死的留痕。 */
  getProcessHealth: () => Promise<ProcessHealthReport>
  /** 在系统文件管理器中定位项目文件夹（损坏项目的自救入口，#38）。 */
  revealProjectFolder: (projectPath: string) => Promise<void>
  checkReleaseGuard: () => Promise<ReleaseGateVerdict>
  /** 匿名使用统计（ADR-0039）：读当前开关、告知版本与匿名 ID。 */
  getTelemetryState: () => Promise<TelemetryState>
  setTelemetryEnabled: (enabled: boolean) => Promise<TelemetryState>
  /** 用户看完告知屏点了确认；在此之前一个事件都不发。 */
  acknowledgeTelemetryNotice: () => Promise<TelemetryState>
  resetTelemetryAnonymousId: () => Promise<TelemetryState>
  /** 在文件管理器里定位待发队列文件（"发了什么明文可查"的兑现入口）。 */
  revealTelemetryQueue: () => Promise<void>
  getUpdaterState: () => Promise<UpdaterState>
  checkForUpdates: () => Promise<void>
  installUpdate: () => Promise<void>
  onUpdaterStateChanged: (callback: (state: UpdaterState) => void) => () => void
  getConfig: () => Promise<AppConfigPayload>
  saveConfig: (config: AppConfig) => Promise<AppConfigPayload>
  setPrimaryModel: (key: string) => Promise<AppConfigPayload>
  setApiKey: (provider: ProviderId, apiKey: string) => Promise<{ hasApiKey: boolean }>
  deleteApiKey: (provider: ProviderId) => Promise<{ hasApiKey: boolean }>
  hasApiKey: (provider: ProviderId) => Promise<{ hasApiKey: boolean }>
  testConnection: (provider: ProviderId) => Promise<ConnectionTestResult>
  listProviderModels: (provider: ProviderId) => Promise<ProviderModelListResult>
  getNarraCatDiagnostics: () => Promise<NarraCatAgentCoreDiagnostics>
  readOfficialSkillBody: (input: { skillId: string }) => Promise<string>
  listProseBlocks: (input: { agentId: string }) => Promise<ProseBlockView[]>
  setProseBlock: (input: { agentId: string; id: string; text: string }) => Promise<ProseBlockView[]>
  resetProseBlock: (input: { agentId: string; id: string }) => Promise<ProseBlockView[]>
  resetAllProseBlocks: (input: { agentId: string }) => Promise<ProseBlockView[]>
  listAuthorRequests: (input: { agentId: string }) => Promise<AuthorRequest[]>
  addAuthorRequest: (input: { agentId: string; text: string }) => Promise<AuthorRequest[]>
  updateAuthorRequest: (input: { agentId: string; id: string; text: string }) => Promise<AuthorRequest[]>
  removeAuthorRequest: (input: { agentId: string; id: string }) => Promise<AuthorRequest[]>
  listCapabilityPacks: () => Promise<CapabilityPackSummary[]>
  previewCapabilityPackImport: () => Promise<PreviewImportPackResult | { status: 'canceled' }>
  confirmCapabilityPackImport: (input: { token: string }) => Promise<ImportPackResult>
  cancelCapabilityPackImport: (input: { token: string }) => Promise<void>
  getCapabilityPackDetail: (input: { id: string; version?: string }) => Promise<PackDetailResult>
  exportCapabilityPackTemplate: () => Promise<ExportPackResult | { status: 'canceled' }>
  uninstallCapabilityPack: (input: { id: string; version: string }) => Promise<CapabilityPackSummary[]>
  exportCapabilityPack: (input: {
    id: string
    version: string
    license: PackLicense
    rightsConfirmed: boolean
    readme?: string
  }) => Promise<ExportPackResult | { status: 'canceled' }>
  // 造包中心「创作工程」草稿存储（B2 刀3 Task 10）
  listPackDrafts: () => Promise<PackDraftMeta[]>
  getPackDraft: (input: { draftId: string }) => Promise<{ meta: PackDraftMeta; cards: DraftCard[]; readme: string } | null>
  createPackDraft: (input: { name: string }) => Promise<PackDraftMeta>
  updatePackDraft: (input: {
    draftId: string
    patch: { meta?: Partial<PackDraftMeta>; cards?: DraftCard[]; readme?: string }
  }) => Promise<void>
  deletePackDraft: (input: { draftId: string }) => Promise<void>
  exportPackDraftProject: (input: { draftId: string }) => Promise<ExportPackDraftProjectResult>
  importPackDraftProject: () => Promise<ImportPackDraftProjectResult>
  compileDraftCard: (input: { draftId: string; cardId: string }) => Promise<CompileDraftCardResult>
  previewDraftCard: (input: { draftId: string; cardId: string }) => Promise<PreviewDraftCardResult>
  publishPackDraft: (input: {
    draftId: string
    version: string
    acknowledgeWarnings?: boolean
  }) => Promise<PublishPackDraftResult>
  copyPackToDraft: (input: { id: string; version: string }) => Promise<PackDraftMeta | null>
  getLocalPackContent: (input: { id: string; version: string }) => Promise<LocalPackContent | null>
  // 造包中心「从书学写法」（B2 刀4 Task 11）：txt 选择 / 预估 / 学习编排 + 事件推送。
  pickLearnTxt: () => Promise<{ filePath: string; title: string } | null>
  estimateLearn: (input: { source: PackLearnSource; tier: PackLearnTier }) => Promise<PackLearnEstimate>
  startLearn: (input: { source: PackLearnSource; tier: PackLearnTier }) => Promise<PackLearnResult>
  cancelLearn: () => Promise<{ ok: true }>
  // 造包中心「作家向导」（B2 刀5 Task 4）：多轮访谈 start/send/cancel + 事件推送；
  // snapshot/dismiss 支撑会话可恢复（重载后水合现场 / 终态「再来一次」清场）。
  startWizard: () => Promise<PackWizardAck>
  sendWizardMessage: (input: { text: string }) => Promise<PackWizardAck>
  cancelWizard: () => Promise<{ ok: true }>
  getWizardSnapshot: () => Promise<PackWizardSnapshot | null>
  dismissWizard: () => Promise<PackWizardAck>
  getNovelPacks: (input: { projectPath: string }) => Promise<NovelPacksFile>
  setNovelPacks: (input: { projectPath: string; enabled: NovelPacksEntry[] }) => Promise<NovelPacksFile>
  getChapterCapabilityReceipt: (input: {
    projectPath: string
    chapter: number
  }) => Promise<ChapterCapabilityReceiptData | null>
  getPlanningCapabilityReceipts: (input: { projectPath: string }) => Promise<PlanningCapabilityReceiptData[]>
  runEmbeddingHealthProbe: () => Promise<EmbeddingHealthProbeResult>
  runCorpusHealthProbe: () => Promise<CorpusHealthProbeResult>
  listResultNotifications: () => Promise<ResultNotificationList>
  upsertResultNotification: (notification: ResultNotification) => Promise<ResultNotificationList>
  markResultNotificationRead: (id: string) => Promise<ResultNotificationList>
  markAllResultNotificationsRead: () => Promise<ResultNotificationList>
  readWorkLocation: () => Promise<StoredWorkLocation>
  writeWorkLocation: (location: StoredWorkLocation) => Promise<void>
  listNovelProjects: () => Promise<NovelProjectSummary[]>
  createNovelProjectBackup: (projectPath: string) => Promise<CreateNovelProjectBackupDialogResult>
  restoreNovelProjectBackup: () => Promise<RestoreNovelProjectBackupDialogResult>
  rememberNovelProjectPath: (input: RememberNovelProjectPathInput) => Promise<{ updated: boolean }>
  createNovelProject: (input: CreateNovelProjectInput) => Promise<CreatedNovelProject>
  updateNovelProjectMetadata: (input: UpdateNovelProjectMetadataInput) => Promise<NovelProjectDetail>
  deleteNovelProject: (input: DeleteNovelProjectInput) => Promise<DeleteNovelProjectResult>
  getNovelProject: (projectPath: string, selectedChapter?: number) => Promise<NovelProjectDetail>
  readNovelStatus: (projectPath: string) => Promise<NovelStatusSnapshot | null>
  refreshNovelStatus: (projectPath: string) => Promise<NovelStatusSnapshot>
  listAppearedCharacters: (projectPath: string) => Promise<CharacterContactList>
  readCharacterState: (input: {
    projectPath: string
    characterUid: string
    characterName: string
  }) => Promise<CharacterStateSnapshot>
  readPlannedState: (input: ReadPlannedStateInput) => Promise<PlannedStateReadResult>
  readPlannedStateCounts: (input: ReadPlannedStateCountsInput) => Promise<PlannedStateCounts>
  readMemoryGraph: (input: { projectPath: string }) => Promise<MemoryGraphSnapshot>
  enrichCharacterStatuses: (input: {
    projectPath: string
    characterUids: string[]
    knowledgeBoundaryChapter: number | null
  }) => Promise<Record<string, string>>
  getNovelChapterArtifacts: (
    projectPath: string,
    chapterNumber: number,
    volumeNumber?: number,
  ) => Promise<NovelChapterArtifacts>
  getNovelWorkbenchArtifacts: (
    projectPath: string,
    objectId: string,
    volumeNumber?: number,
  ) => Promise<NovelWorkbenchArtifacts>
  submitPremiseFieldEdit: (input: PremiseFieldEditInput) => Promise<PremiseEditResult>
  submitChapterOutlineFieldEdit: (input: ChapterOutlineFieldEditInput) => Promise<{ ok: boolean; message?: string }>
  submitMasterOutlineFieldEdit: (input: MasterOutlineFieldEditInput) => Promise<{ ok: boolean; message?: string }>
  submitAuthoredState: (input: AuthoredStateEditInput) => Promise<{ ok: boolean; message?: string }>
  submitStyleAnchor: (input: {
    projectPath: string
    action: 'add' | 'remove'
    chapter?: number
    excerpt?: string
    anchorId?: string
  }) => Promise<{ ok: boolean; message?: string; anchorId?: string; total?: number }>
  listStyleAnchors: (input: { projectPath: string }) => Promise<{
    ok: boolean
    anchors: Array<{ anchorId: string; chapter: number; excerpt: string; createdAt: string }>
    max: number
    message?: string
  }>
  resolvePlannedState: (input: ResolvePlannedStateInput) => Promise<{ ok: boolean; message?: string }>
  updateChapterStateChanges: (input: UpdateChapterStateChangesInput) => Promise<{ ok: boolean; message?: string }>
  submitCharacterIdentity: (input: CharacterIdentityEditInput) => Promise<{ ok: boolean; message?: string }>
  saveChapterManuscript: (input: ManuscriptEditInput) => Promise<ManuscriptSaveResult>
  listManuscriptRevisions: (input: ManuscriptRevisionInput) => Promise<ManuscriptRevisionList>
  readManuscriptRevision: (input: ReadManuscriptRevisionInput) => Promise<ManuscriptRevisionContent>
  restoreManuscriptRevision: (input: RestoreManuscriptRevisionInput) => Promise<ManuscriptSaveResult>
  getManuscriptDraft: (input: ManuscriptDraftInput) => Promise<ManuscriptDraftState>
  saveManuscriptDraft: (input: SaveManuscriptDraftInput) => Promise<{ ok: true }>
  discardManuscriptDraft: (input: ManuscriptDraftInput) => Promise<{ ok: true }>
  listManuscriptDrafts: (projectPath: string) => Promise<ManuscriptDraftSummary[]>
  getPendingMemorySync: (projectPath: string) => Promise<Record<string, PendingMemorySyncEntry>>
  clearPendingMemorySync: (input: { projectPath: string; chapter: number }) => Promise<{ ok: boolean }>
  pasteReferenceSource: (input: PasteReferenceSourceInput) => Promise<ReferenceWorksSummary>
  importReferenceSourceFiles: (projectPath: string) => Promise<ReferenceWorksSummary>
  removeReferenceSource: (input: RemoveReferenceSourceInput) => Promise<ReferenceWorksSummary>
  clearReferenceGuidance: (projectPath: string) => Promise<ReferenceWorksSummary>
  resetReferenceWorks: (projectPath: string) => Promise<ReferenceWorksSummary>
  selectDirectory: () => Promise<string | null>
  startAgentRun: (request: AgentRunRequest) => Promise<AgentRunStarted>
  cancelAgentRun: (input: { runId: string; requestId: string }) => Promise<{ cancelled: boolean }>
  answerAgentQuestion: (answer: {
    requestId: string
    questionRequestId: string
    answers: Record<string, string>
  }) => Promise<{ accepted: boolean }>
  forgetAgentSession: (input: { threadId: string; requestId: string }) => Promise<void>
  getAgentThreadSnapshot: (input: { threadId: string; segmentId?: string }) => Promise<AgentThreadSnapshotV1>
  getAgentEventsAfter: (input: {
    threadId: string
    segmentId: string
    afterSeq: number
  }) => Promise<AgentEventsAfterResultV1>
  listAgentHistorySegments: (threadId: string) => Promise<AgentHistorySegmentSummaryV1[]>
  startNewAgentConversation: (input: AgentStartNewConversationInput) => Promise<AgentThreadSnapshotV1>
  sendCharacterChatMessage: (request: CharacterChatSendRequest) => Promise<{ runId: string }>
  cancelCharacterChat: (runId: string) => Promise<{ cancelled: boolean }>
  onCharacterChatEvent: (callback: (event: CharacterChatStreamEvent) => void) => () => void
  readCharacterChatTranscript: (input: {
    projectPath: string
    characterUid: string
    userMode: CharacterChatUserMode
  }) => Promise<CharacterChatTranscript>
  saveCharacterChatTranscript: (input: {
    projectPath: string
    characterUid: string
    userMode: CharacterChatUserMode
    messages: CharacterChatTranscript['messages']
  }) => Promise<CharacterChatTranscript>
  readCharacterChatProfiles: (input: {
    projectPath: string
    characterUid: string
  }) => Promise<CharacterChatProfiles>
  saveCharacterChatProfile: (input: {
    scope: 'author' | 'impression'
    content: string
    projectPath: string
    characterUid: string
  }) => Promise<void>
  flushCharacterChatProfile: (input: {
    projectPath: string
    characterUid: string
    characterName: string
  }) => Promise<void>
  onAgentEvent: (callback: (event: AgentEventEnvelopeV1) => void) => () => void
  onPackLearnEvent: (callback: (event: PackLearnEvent) => void) => () => void
  onPackWizardEvent: (callback: (event: PackWizardEvent) => void) => () => void
  onOpenResultNotification: (callback: (notification: ResultNotification) => void) => () => void
  onResultNotificationsChanged: (callback: (event: ResultNotificationList) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronApi
  }
}

export {}
