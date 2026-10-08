// 能力包（Capability Pack）共享类型：渲染端与主进程共用（B2 刀1，ADR-0034 v1.1）。
//
// 双轨版本制（v1.1）：官方内置包随引擎走，不带 version 锁定；用户导入包锁版本，
// 同 id 允许多版本并存（list 按版本各返回一行，UI/启用面板按 id+version 定位）。

import type { CardLintFinding } from '@shared/lib/capability-pack-lint'

/** 学习产出摘要（成功终态通知与草稿编辑器共用）。 */
export interface PackLearnReport {
  cardsKept: number
  cardsDropped: number
  chaptersSampled: number
}

export type PackLearnResult =
  | { status: 'ok'; draftId: string; report: PackLearnReport }
  | { status: 'error'; message: string }
  | { status: 'cancelled' }

export type PackLearnSource =
  | { kind: 'novel'; projectPath: string; title: string }
  | { kind: 'file'; filePath: string; title: string }
  | { kind: 'txt'; filePath: string; title: string }

export interface CapabilityPackSummary {
  id: string
  name: string
  author: string
  version: string
  description?: string
  /** manifest.min_engine_version 透传（v1 仅展示层用途，不做强校验） */
  minEngineVersion?: string
  origin: 'official' | 'user'
  cardCount: number
  cardTypeCounts: { persona: number; craft: number; structure: number; benchmark: number }
}

/** 小说启用面板记录：官方内置包不带 version（随引擎走）；导入包必带（锁定）——渲染端与主进程共用 */
export interface NovelPacksEntry {
  id: string
  version?: string
}

export type ImportPackResult =
  | { status: 'ok'; packs: CapabilityPackSummary[] }
  | { status: 'invalid' | 'conflict'; message: string }

export type ExportPackResult =
  | { status: 'ok'; filePath: string }
  /** forbidden：来源 provenance 标记 learned-external（从外部作品学得），仅限本机使用，不可导出分享（B2 刀3）。 */
  | { status: 'invalid' | 'not-found' | 'forbidden'; message: string }

export const DEFAULT_ENABLED_PACK_IDS = ['official-base'] as const

export const PACK_FILE_EXTENSION = '.narracatpack'

/** 造包中心「创作工程」（草稿包）导出/导入文件扩展名（B2 刀3，与已发布包 `.narracatpack` 区分）。 */
export const PACK_DRAFT_PROJECT_FILE_EXTENSION = '.narracatproj'

/** 官方内置包 id 保留前缀（用户导入包禁用，见 pack-store.ts importCapabilityPack 校验序）。 */
export const OFFICIAL_PACK_ID_PREFIX = 'official-'

// pack.json manifest 契约镜像（与引擎 Task 1 `agent-core/narracat/mcp-server/src/packs/pack-manifest.ts` 对齐，
// App 侧不跨界 import 引擎源码，故在此共享文件内维护同形状类型供 electron/main/packs/pack-manifest.ts 校验用）。

export const PACK_FORMAT_VERSION = 1

/** SemVer（不支持 build metadata `+`——`+` 在 `<id>@<version>` 目录名里不安全）。 */
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function parseSemverForCompare(v: string): { major: number; minor: number; patch: number; prerelease: string[] } {
  const dashIdx = v.indexOf('-')
  const core = dashIdx === -1 ? v : v.slice(0, dashIdx)
  const pre = dashIdx === -1 ? '' : v.slice(dashIdx + 1)
  const [major, minor, patch] = core.split('.').map((n) => Number(n))
  return { major, minor, patch, prerelease: pre ? pre.split('.') : [] }
}

function compareSemverIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) return Number(a) - Number(b)
  if (aNumeric && !bNumeric) return -1 // 数字标识符优先级恒低于字母数字标识符（SemVer 11.4.4）
  if (!aNumeric && bNumeric) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * SemVer 优先级比较（不含 build metadata，见 `SEMVER_RE`）。纯函数：<0 表示 a<b，>0 表示 a>b，0 表示等价。
 * 无预发布版本 > 有预发布版本；预发布标识符逐位比较，数字标识符数值比较且恒小于字母数字标识符，
 * 前缀相同时标识符更多者优先级更高（SemVer 规范 11.2-11.4）。
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemverForCompare(a)
  const pb = parseSemverForCompare(b)
  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  if (pa.patch !== pb.patch) return pa.patch - pb.patch
  const aHasPre = pa.prerelease.length > 0
  const bHasPre = pb.prerelease.length > 0
  if (aHasPre && !bHasPre) return -1
  if (!aHasPre && bHasPre) return 1
  if (!aHasPre && !bHasPre) return 0
  const len = Math.max(pa.prerelease.length, pb.prerelease.length)
  for (let i = 0; i < len; i++) {
    if (i >= pa.prerelease.length) return -1
    if (i >= pb.prerelease.length) return 1
    const cmp = compareSemverIdentifier(pa.prerelease[i], pb.prerelease[i])
    if (cmp !== 0) return cmp
  }
  return 0
}

export const STRUCTURE_STAGES = ['stage-1', 'stage-2', 'stage-opening'] as const
export type StructureStage = (typeof STRUCTURE_STAGES)[number]

/** 结构阶段展示文案（Task 12 UI 用）。 */
export const STRUCTURE_STAGE_LABELS: Record<StructureStage, string> = {
  'stage-opening': '开局设计',
  'stage-1': '全书布局',
  'stage-2': '逐章编排',
}

interface PackCardBase {
  type: string
  path: string
  id: string
}
export interface PersonaCardEntry extends PackCardBase {
  type: 'persona'
  name: string
  keywords: string[]
}
export interface CraftCardEntry extends PackCardBase {
  type: 'craft'
  triggers: string[]
  beat_types: string[]
  technique_tags: string[]
  emotion_tags: string[]
  exclusions: string[]
  priority: number
}
export interface StructureCardEntry extends PackCardBase {
  type: 'structure'
  dimension: string
  stage: StructureStage
  one_line: string
}
export interface BenchmarkCardEntry extends PackCardBase {
  type: 'benchmark'
  genre: string
}
export type PackCardEntry = PersonaCardEntry | CraftCardEntry | StructureCardEntry | BenchmarkCardEntry

/** 包授权类型（权利元数据，ADR-0034）。 */
export type PackLicense = 'personal-only' | 'share-no-derivatives' | 'free-use'

/** 授权类型展示文案。 */
export const PACK_LICENSE_LABELS: Record<PackLicense, string> = {
  'personal-only': '仅供个人使用',
  'share-no-derivatives': '可自由分享·不可修改再发',
  'free-use': '可自由使用和修改',
}

/** 授权类型合法值判定：主进程校验（pack-manifest.ts）与 IPC 入参校验（ipc.ts）共用同一份，避免重复实现分叉。 */
export function isPackLicense(v: unknown): v is PackLicense {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PACK_LICENSE_LABELS, v)
}

/** 权利元数据：并入 `PackManifest` 可选字段；`content_hash` 供来源核验、`derived_from` 记录蒸馏/学习来源包 id。 */
export interface PackRightsMetadata {
  content_hash?: string
  license?: PackLicense
  derived_from?: string
}

export interface PackManifest extends PackRightsMetadata {
  pack_format_version: number
  id: string
  name: string
  author: string
  version: string
  description?: string
  min_engine_version?: string
  changelog?: string
  publisher_id?: string
  cards: PackCardEntry[]
}

// 章级能力回执（`.narracat/capability-receipts/ch-NNN.json` 镜像，Task 9b 消费，spec §4.4）。
// 展示边界（spec §6）：回执只记录「用了哪张卡」，绝不携带卡正文——渲染端不得展示卡内容。

export interface ChapterCapabilityReceiptEntry {
  card_id: string
  type: string
  pack_id: string
  pack_version: string
  origin: string
  consumer: string
  reason: string
}

export interface ChapterCapabilityReceiptData {
  chapter: number
  entries: ChapterCapabilityReceiptEntry[]
  warnings: string[]
}

// 规划期装载回执（`.narracat/capability-receipts/planning-<stage>.json` 镜像，engine
// `writePlanningCapabilityReceipt` 落盘产物，B2 刀3 Task 10 消费）。与章级回执不同：这里记的是
// 「候选池全量装载」而非「选中命中」，故字段集不同（无 consumer/reason，多 dimension/one_line）。

export interface PlanningCapabilityReceiptEntry {
  card_id: string
  pack_id: string
  pack_version: string
  origin: string
  dimension: string
  one_line: string
}

export interface PlanningCapabilityReceiptData {
  stage: StructureStage
  generated_at: string
  entries: PlanningCapabilityReceiptEntry[]
}

// ---- B2 刀2：详情页 / 两阶段导入（spec 2026-07-19）----

/** 包长文说明固定文件名：只认包根 README.md，作者主动写给人看（渲染不破展示边界）。 */
export const PACK_README_FILENAME = 'README.md'
/** README 读取上限（256KB），超限截断展示并标注 readmeTruncated。 */
export const PACK_README_MAX_BYTES = 262144

/** 模板样例包 id（随应用内置，不进包库，仅供制作指南页导出）。 */
export const TEMPLATE_PACK_ID = 'template-starter'

export interface CapabilityPackDetail {
  manifest: PackManifest
  origin: 'official' | 'user'
  readme?: string
  readmeTruncated?: boolean
  /** 该 id 全部已装版本，SemVer 降序（首个 = 已装最新版）。官方包恒为单元素。 */
  installedVersions: string[]
  /** 本机来源标记（造包中心/刀3，Task 10 赋值）。 */
  localSource?: PackLocalSource
  /** 权利元数据（Task 10 赋值）。 */
  rights?: PackRightsMetadata
}

export type PackDetailResult =
  | { status: 'ok'; detail: CapabilityPackDetail }
  | { status: 'not-found'; message: string }

export type PreviewImportPackResult =
  | {
      status: 'ok'
      token: string
      manifest: PackManifest
      readme?: string
      readmeTruncated?: boolean
      /** staging 内 cards/*.md 逐卡 lint 扫描结果，按文件聚合；只警示不阻断（B2 刀3 Task 9）。 */
      lintWarnings: Array<{ file: string; severity: 'block' | 'warn'; findings: CardLintFinding[] }>
    }
  | { status: 'invalid' | 'conflict'; message: string }

// ---- B2 刀3：造包中心（书蒸馏 / 作家向导，spec 待定）----

/** 本机来源：作者原创 / 从自己作品学得 / 从外部作品学得（决定权利元数据默认值与展示提示）。 */
export type PackLocalSource = 'created' | 'learned-own' | 'learned-external'

/** 学习来源摘要（草稿工程 meta 与 UI 展示用；title 是书名/文件名）。 */
export interface PackLearnedFrom {
  sourceKind: 'novel' | 'file' | 'txt'
  title: string
}

export type PackLearnTier = 'skim' | 'deep'

export type PackLearnEstimate =
  | { status: 'ok'; chapterCount: number; sampledCount: number; approxChars: number }
  | { status: 'error'; message: string }

export interface PackLearnEvent {
  phase: 'preparing' | 'reading' | 'scanning' | 'saving' | 'done' | 'error' | 'cancelled'
  message: string
  draftId?: string
}

// ---- B2 刀5：作家向导（多轮访谈把作者自述写法整理成能力卡草稿）----

/**
 * 向导会话阶段：preparing → awaiting_user ⇄ thinking → saving → done | error | cancelled。
 * 终态三值（done/error/cancelled）不经 `kind: 'phase'` 事件下发——各自有专属事件 kind，
 * 恰好 emit 一次（刀4 终态单发不变量）；渲染端从终态事件回推 phase。
 */
export type PackWizardPhase = 'preparing' | 'awaiting_user' | 'thinking' | 'saving' | 'done' | 'error' | 'cancelled'

/** 访谈单条消息（主进程 transcript 与渲染端消息流共用同一形状，快照恢复零转换）。 */
export interface PackWizardMessage {
  role: 'user' | 'assistant'
  text: string
}

/**
 * done 事件卡级摘要（诚实完成页）：编译成没成、代表性预览命中几次，逐卡如实报。
 * previewHits=null 三义共担：structure 卡（整批装载语义，无「命中」概念）/ 未编译成功（预览
 * 前置条件缺失）/ 预览异常（容忍不阻断 done）——三者对完成页同义：不据此下警示。
 */
export interface PackWizardCardSummary {
  name: string
  type: 'persona' | 'craft' | 'structure'
  compiled: boolean
  previewHits: number | null
}

/** 事件载荷（不含序号）；主进程 emit 唯一出口统一盖章 seq 后成为 PackWizardEvent。 */
export type PackWizardEventBody =
  | { kind: 'phase'; phase: PackWizardPhase }
  | { kind: 'assistant'; text: string }
  /**
   * draftId 为 null = 访谈没聊出可炼的写法（cards 为空），不落工程（原因看已下发的 assistant 文本）。
   * cards / droppedCount 为可选增量字段（刀5 修复波）：cards 是落盘卡的逐卡摘要；droppedCount 是
   * 因格式不完整被放弃的卡数（完成页如实交代）。
   */
  | { kind: 'done'; draftId: string | null; cardCount: number; cards?: PackWizardCardSummary[]; droppedCount?: number }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' }

/**
 * seq：会话实例内单调递增（从 1）。渲染端水合（快照 + 事件重放）靠它去重——快照带 lastSeq，
 * 重放只应用 seq > lastSeq 的事件；迟到/乱序事件同理由 seq 门丢弃，不再单靠 started 盲丢。
 */
export type PackWizardEvent = PackWizardEventBody & { seq: number }

/**
 * 主进程会话快照（单一真相源可重建）：页面重载后渲染端 store 清空，但主进程会话还在——
 * 进向导时先取快照整体重建现场（进行中恢复对话视图，终态恢复终态页），再用事件流续播。
 */
export interface PackWizardSnapshot {
  phase: PackWizardPhase
  messages: PackWizardMessage[]
  draftId: string | null
  cardCount: number | null
  errorMessage: string | null
  lastSeq: number
  /** done 终态的卡级摘要与放弃数（可选增量字段，与 done 事件同源）：重载后完成页警示行不丢。 */
  cards?: PackWizardCardSummary[] | null
  droppedCount?: number | null
}

/** start/send 的受理回执：ok=false 表示这次调用被拒（busy/终态/时机不对），结果本身走事件流。 */
export type PackWizardAck = { ok: true } | { ok: false; message: string }

/**
 * 向导单条消息长度上限（字符）。超限拒发不截断——截断会腰斩作者文字，比拒发更不诚实（spec §7
 * 「截断+提示」的裁决偏离，收尾修复波在案）。两侧单一来源：渲染端 WizardComposer 发送前预检
 * 就地提示，主进程 pack-wizard.send 兜底走既有 ack 拒收路径。
 */
export const WIZARD_INPUT_MAX_CHARS = 50_000

/** 超限拒发的大白话原因（两侧共用同一句，防漂移）。 */
export const WIZARD_INPUT_TOO_LONG_MESSAGE = '这条消息太长了，请删减后再发（上限 5 万字）。'

/** 造包草稿元信息（未发布/已发布过再改的包草稿）。 */
export interface PackDraftMeta {
  draftId: string
  name: string
  author: string
  description: string
  lastPublishedVersion: string | null
  derivedFrom: string | null
  updatedAt: string
  /** 首次发布时定下的包 id（`user-` + slug(name)，冲突加短 uuid 后缀），此后固定不变（Task 7）。未发布过为空。 */
  packId?: string
  /** 本机来源；缺省视同 'created'（刀4 学习工程写入 learned-own/learned-external，永久锁定）。 */
  localSource?: PackLocalSource
  /** 学习来源摘要（仅学习工程有）。 */
  learnedFrom?: PackLearnedFrom
}

/** 卡编译产物（作者写自然语言意图 → 引擎编译出结构化字段）。 */
export interface CompiledCardMeta {
  fields: Record<string, unknown>
  echo: string
  engineVersion: string
  compiledAt: string
}

/** 造包草稿内的一张卡：作者写正文 + 意图，compiled 为空表示尚未编译。 */
export interface DraftCard {
  cardId: string
  type: 'persona' | 'craft' | 'structure'
  name: string
  oneLine: string
  body: string
  intent: string
  compiled: CompiledCardMeta | null
}

/** 本机产物卡正文（`packs:local-content` 通道结果，Task 8/10）。 */
export interface LocalPackContent {
  localSource: PackLocalSource
  cards: Array<{ fileName: string; body: string }>
}

/** 造包中心可用词表选项条目（scenarios/voices 展示项，Task 12 UI 用）。 */
export interface PackAuthoringVocabOption {
  id: string
  name: string
}

/** 造包中心引擎词表全量（`novel_pack_authoring_vocab` 只读工具透传，Task 10 缓存进程内存）。 */
export interface PackAuthoringVocab {
  emotion_tags: string[]
  technique_tags: string[]
  structure_stages: string[]
  scenarios: PackAuthoringVocabOption[]
  voices: PackAuthoringVocabOption[]
}

export type ExportPackDraftProjectResult =
  | { status: 'ok'; filePath: string }
  | { status: 'canceled' }
  | { status: 'invalid'; message: string }

export type ImportPackDraftProjectResult =
  | { status: 'ok'; meta: PackDraftMeta }
  | { status: 'canceled' }
  | { status: 'invalid'; message: string }
