import type { NarraCatArtifactKind } from './narracat'

export type NovelProjectStatus = 'ready' | 'needs-setup' | 'needs-outline' | 'in-progress' | 'invalid'
/** 落盘为 `.narracat/config.yaml` 顶层 `automation_level`；控制状态，不外露到对话流（ADR-0016）。 */
export type NovelAutomationLevel = 'collaborative' | 'auto'
export type NovelTocItemKind = 'volume' | 'chapter'
export type NovelChapterStatus =
  | 'completed'
  | 'in-progress'
  | 'recoverable'
  /** 正式正文缺失，但写作链留有未 promote 的 staging 草稿（写作中断，可只读预览）。 */
  | 'interrupted-draft'
  | 'planned'
  | 'missing-outline'
  | 'missing-manuscript'
export type NovelWorkbenchObjectKind =
  | 'master-outline'
  | 'narrator-voice'
  | 'foundation'
  | 'bible-document'
  | 'bible-group'
  | 'character-list'
  | 'character'
  | 'world-list'
  | 'world'
  | 'reference-list'
  | 'volume'
  | 'volume-outline'
  | 'chapter'

export type NovelWorkbenchArtifactKind =
  | 'markdown'
  | 'json'
  | 'summary'
  | 'chapter-outline'
  | 'manuscript'
  | 'context-pack'
  | 'review'
  | 'deep-review'

export interface NovelProjectSummary {
  id: string
  title: string
  genre: string
  coverPreset: string
  path: string
  status: NovelProjectStatus
  chapterProgress: string
  wordCountLabel: string
  /** 原始总字数（纯文字）。首页 banner 聚合用此精确求和，不从 wordCountLabel 反解。 */
  wordCountTotal?: number
  /** 当前自动化模式；config.yaml 读不到（项目损坏）时缺省，UI 据此隐藏切换入口。 */
  automationLevel?: NovelAutomationLevel
  updatedAt?: string
  problem?: string
  checkpoint?: NovelCheckpoint | null
}

export interface RememberNovelProjectPathInput {
  novelId: string
  previousPath: string
  currentPath: string
}

export type NovelSummary = Pick<NovelProjectSummary, 'id' | 'title' | 'chapterProgress' | 'wordCountLabel'>

export interface NovelTocItem {
  id: string
  kind: NovelTocItemKind
  title: string
  active?: boolean
  chapterNumber?: number
  volumeNumber?: number
  status?: NovelChapterStatus
}

export interface NovelWorkbenchTreeItem {
  id: string
  kind: NovelWorkbenchObjectKind
  title: string
  level: number
  path?: string
  exists?: boolean
  chapterNumber?: number
  volumeNumber?: number
  status?: NovelChapterStatus
  parentId?: string
}

export interface NovelWorkbenchArtifact {
  id: string
  kind: NovelWorkbenchArtifactKind
  title: string
  path?: string
  exists: boolean
  content?: string
  data?: unknown
  error?: string
  /** 角色档案 character_identity 解析出的 canonical Character UID（仅角色档案） */
  characterUid?: string
  /** 角色档案 character_identity 的显示名（仅角色档案） */
  characterName?: string
  /** 角色档案完善度阶段（渐进深化 stub→sketch→full；缺该字段的旧档按 full）。仅角色档案。 */
  characterProfileStage?: CharacterProfileStage
  /** 候选角色（写作中出现、尚未建档，仅在候选池登记）。true 时无正式文件，渲染走候选引导页。 */
  isCandidateCharacter?: boolean
  /** 候选角色被提议出场的章号（来自候选池，可空）。 */
  candidateProposedChapter?: number | null
  /** 候选角色登记时的一句话备注（来自候选池，可空）。 */
  candidateNote?: string | null
  /** 候选角色重要度（来自候选池）：minor（次要，静默）/ major（重要，写完正文会提醒建档）。仅候选角色。 */
  candidateImportance?: 'minor' | 'major'
  /** 正文来自写作中断的 staging 草稿（未 promote），非正式正文。仅 kind: 'manuscript'。只读预览用。 */
  isDraft?: boolean
}

/** 角色档案完善度阶段：stub（写作期就地拉起）→ sketch（关键维度成形）→ full（全维度完整）。 */
export type CharacterProfileStage = 'stub' | 'sketch' | 'full'

export type ReferenceGuidanceState = 'empty' | 'needs-analysis' | 'stale' | 'current'

export interface ReferenceSourceItem {
  id: string
  fileName: string
  title: string
  relativePath: string
  path: string
  extension: '.md' | '.txt'
  size: number
  wordCount: number
  updatedAt: string
}

export interface ReferenceWorksStatus {
  guidanceState: ReferenceGuidanceState
  sourceCount: number
  needsAnalysis: boolean
  stale: boolean
  latestSourceUpdatedAt?: string
  guidanceExists: boolean
  guidanceUpdatedAt?: string
}

export interface ReferenceGuidanceSummary {
  exists: boolean
  relativePath: string
  path: string
  updatedAt?: string
  content?: string
}

export interface ReferenceWorksSummary {
  sources: ReferenceSourceItem[]
  guidance?: ReferenceGuidanceSummary
  status: ReferenceWorksStatus
}

export interface PasteReferenceSourceInput {
  projectPath: string
  title: string
  content: string
}

export interface RemoveReferenceSourceInput {
  projectPath: string
  fileName: string
}

export interface NovelWorkbenchArtifacts {
  projectPath: string
  objectId: string
  objectKind: NovelWorkbenchObjectKind
  title: string
  artifacts: NovelWorkbenchArtifact[]
  referenceWorksSummary?: ReferenceWorksSummary
}

export interface NovelProjectDetail extends NovelProjectSummary {
  tocItems: NovelTocItem[]
  treeItems: NovelWorkbenchTreeItem[]
  selectedChapter?: number
  checkpoint?: NovelCheckpoint | null
}

export interface NovelCheckpoint {
  lastCommand: string | null
  lastStep: number | null
  timestamp: string | null
}

export interface NovelArtifact {
  kind: NarraCatArtifactKind
  title: string
  path: string
  exists: boolean
  content?: string
  data?: unknown
  error?: string
  /** 正文来自写作中断的 staging 草稿（未 promote），非正式正文。仅 kind: 'manuscript'。只读预览用。 */
  isDraft?: boolean
}

export interface NovelChapterArtifacts {
  projectPath: string
  chapterNumber: number
  volumeNumber?: number
  artifacts: NovelArtifact[]
}

// --- 工作台状态面板（机械聚合快照，不经 LLM / MCP run）-----------------------

export interface NovelStatusBook {
  title: string
  genre: string
}

export interface NovelStatusProgress {
  completedChapters: number
  totalChaptersPlanned: number
  percentage: number
  inProgressChapter: number | null
  wordCountTotal: number
  avgWordsPerChapter: number
}

export interface NovelStatusCheckpoint {
  lastCommand: string | null
  lastStep: number | null
  timestamp: string | null
}

export interface NovelStatusNextAction {
  chapter: number | null
}

/** 当前 arc（来自 memory.db arc_meta，只读聚合）。无大纲时缺省。 */
export interface NovelStatusArc {
  arcId: string
  volumeNo: number | null
  title: string
  chapterStart: number | null
  chapterEnd: number | null
  coreQuestion: string
  irreversibleChange: string
}

export type NovelStatusForeshadowingState = 'registered' | 'planted' | 'developing' | 'revealed'
export type NovelStatusForeshadowingType = 'small' | 'medium' | 'major'

/** 单条伏笔的机械导出状态（状态由 foreshadowing_actions_log 最新动作导出）。 */
export interface NovelStatusForeshadowing {
  id: string
  type: NovelStatusForeshadowingType
  description: string
  state: NovelStatusForeshadowingState
  plantedChapter: number | null
  targetReveal: string | null
  /** target 已临近（或已过）但尚未 reveal */
  overdue: boolean
}

/** 未通过审校（FAIL）的章节。 */
export interface NovelStatusReviewFailure {
  chapter: number
}

export interface NovelStatusReferences {
  /** bible/references/ 下存在的参考原文数量 */
  sourceCount: number
  /** bible/reference-guidance/ 已生成参考指导 */
  guidanceGenerated: boolean
}

/**
 * 工作台状态面板的结构化快照。由主进程机械聚合产出（不经 LLM、不跑 Agent run、
 * 不获得 memory.db 写权限），落盘到 `.narracat/status-snapshot.json` 持久化。
 */
export interface NovelStatusSnapshot {
  generatedAt: string
  book: NovelStatusBook
  progress: NovelStatusProgress
  checkpoint: NovelStatusCheckpoint | null
  nextAction: NovelStatusNextAction
  /** memory.db 丰富聚合（#240）；不可用时为 undefined，面板对应区块降级展示 */
  currentArc?: NovelStatusArc | null
  foreshadowing?: NovelStatusForeshadowing[]
  reviewFailures?: NovelStatusReviewFailure[]
  references?: NovelStatusReferences
}

export interface CreateNovelProjectInput {
  title: string
  genre: string
  automationLevel: NovelAutomationLevel
}

export interface CreatedNovelProject {
  project: NovelProjectDetail
  projectPath: string
}

export interface UpdateNovelProjectMetadataInput {
  projectPath: string
  title?: string
  coverPreset?: string
  automationLevel?: NovelAutomationLevel
}

export interface DeleteNovelProjectInput {
  projectPath: string
  title: string
  confirmationTitle: string
}

export interface DeleteNovelProjectResult {
  projectPath: string
  trashed: boolean
}
