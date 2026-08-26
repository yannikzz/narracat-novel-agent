import { NOVEL_PROJECT_INCOMPLETE_MESSAGE } from '@shared/lib/ipc-error'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { isNarraCatProject } from './novel-project'
import { narracatConfigPath, narracatStatePath, narracatStatusSnapshotPath } from './novel-layout'
import { parseYamlRecord, readNumber, readRecord, readString } from './yaml'
import type {
  NovelStatusCheckpoint,
  NovelStatusProgress,
  NovelStatusSnapshot,
} from '@shared/types/novel'

const missingProjectProblem = NOVEL_PROJECT_INCOMPLETE_MESSAGE
const defaultGenre = '未分类'

async function readYamlFile(path: string): Promise<Record<string, unknown>> {
  return parseYamlRecord(await readFile(path, 'utf-8'), path)
}

function readCompletedChapters(progress: Record<string, unknown>): number[] {
  const value = progress.completed_chapters
  if (!Array.isArray(value)) return []
  return value.filter((item): item is number => Number.isInteger(item))
}

function readFiniteInteger(record: Record<string, unknown>, key: string): number | null {
  const value = readNumber(record, key)
  return Number.isInteger(value) ? (value as number) : null
}

function readCheckpoint(state: Record<string, unknown>): NovelStatusCheckpoint | null {
  const checkpoint = readRecord(state, 'checkpoint')
  const lastCommand = checkpoint.last_command

  if (lastCommand === null || lastCommand === undefined) {
    return null
  }

  return {
    lastCommand: typeof lastCommand === 'string' ? lastCommand : null,
    lastStep: readFiniteInteger(checkpoint, 'last_step'),
    timestamp: readString(checkpoint, 'timestamp') ?? null,
  }
}

function buildProgress(state: Record<string, unknown>): NovelStatusProgress {
  const progress = readRecord(state, 'progress')
  const structure = readRecord(state, 'structure')
  const wordCount = readRecord(state, 'word_count')
  const completedChapters = readCompletedChapters(progress)
  const completed = completedChapters.length
  const totalChaptersPlanned = Math.max(
    readNumber(progress, 'total_chapters_planned') ?? 0,
    readNumber(structure, 'total_chapters_planned') ?? 0,
  )
  const wordCountTotal = readNumber(wordCount, 'total') ?? 0
  const percentage = totalChaptersPlanned > 0 ? Math.round((completed / totalChaptersPlanned) * 100) : 0
  const avgWordsPerChapter = completed > 0 ? Math.round(wordCountTotal / completed) : 0

  return {
    completedChapters: completed,
    totalChaptersPlanned,
    percentage,
    inProgressChapter: readFiniteInteger(progress, 'in_progress_chapter'),
    wordCountTotal,
    avgWordsPerChapter,
  }
}

/**
 * 机械算下一步章号：优先 in_progress_chapter；否则 last_completed_chapter + 1；
 * 都缺失时回退到「已完成最大章 + 1」或 1（已有规划时）。无规划返回 null。
 */
function resolveNextActionChapter(state: Record<string, unknown>, progress: NovelStatusProgress): number | null {
  if (progress.inProgressChapter !== null) return progress.inProgressChapter

  const progressRecord = readRecord(state, 'progress')
  const lastCompleted = readFiniteInteger(progressRecord, 'last_completed_chapter')
  if (lastCompleted !== null && lastCompleted >= 0) {
    const next = lastCompleted + 1
    if (progress.totalChaptersPlanned === 0 || next <= progress.totalChaptersPlanned) return next
    return null
  }

  if (progress.totalChaptersPlanned > 0) return progress.completedChapters + 1

  return null
}

/**
 * 「当前进展章号」参考：优先已完成最大章；否则进行中章；都缺则 null。
 * 用于丰富聚合里选当前 arc、判伏笔临期。
 */
export function resolveCurrentChapter(state: Record<string, unknown>): number | null {
  const progress = readRecord(state, 'progress')
  const completed = readCompletedChapters(progress)
  if (completed.length > 0) return Math.max(...completed)

  const lastCompleted = readFiniteInteger(progress, 'last_completed_chapter')
  if (lastCompleted !== null && lastCompleted > 0) return lastCompleted

  return readFiniteInteger(progress, 'in_progress_chapter')
}

/**
 * 状态面板聚合的可选丰富输入（#240 memory.db / 项目文件扫描产物）。
 * 缺省时对应区块在快照中省略，由面板降级展示。
 */
export type NovelStatusEnrichment = Pick<
  NovelStatusSnapshot,
  'currentArc' | 'foreshadowing' | 'reviewFailures' | 'references'
>

export interface BuildNovelStatusSnapshotInput {
  projectPath: string
  config: Record<string, unknown>
  state: Record<string, unknown>
  generatedAt: string
  enrichment?: NovelStatusEnrichment
}

export function buildNovelStatusSnapshot({
  projectPath,
  config,
  state,
  generatedAt,
  enrichment,
}: BuildNovelStatusSnapshotInput): NovelStatusSnapshot {
  const progress = buildProgress(state)

  return {
    generatedAt,
    book: {
      title: (readString(config, 'title') ?? basename(projectPath)) || '未命名小说',
      genre: readString(config, 'genre')?.trim() || defaultGenre,
    },
    progress,
    checkpoint: readCheckpoint(state),
    nextAction: { chapter: resolveNextActionChapter(state, progress) },
    ...(enrichment ?? {}),
  }
}

/**
 * 机械聚合当前小说状态快照：读 state.yaml + config.yaml（不调用任何 LLM / Agent run /
 * MCP run）。`enrich` 可注入 memory.db / 项目文件扫描产物（#240）。
 */
export interface NovelStatusAggregationOptions {
  now?: () => Date
  enrich?: (input: { projectPath: string; currentChapter: number | null }) => Promise<NovelStatusEnrichment>
}

async function fileExists(path: string): Promise<boolean> {
  return Boolean(await stat(path).catch(() => null))
}

export async function aggregateNovelStatusSnapshot(
  projectPath: string,
  options: NovelStatusAggregationOptions = {},
): Promise<NovelStatusSnapshot> {
  const trimmed = projectPath.trim()
  if (!trimmed) throw new Error('缺少项目路径。')
  if (!(await isNarraCatProject(trimmed))) {
    // 面向作者的文案保持不变（不把本机路径推到 UI 上），但主进程日志必须留下现场：
    // 没有 projectPath 就无法从一句静态文案倒推是哪个项目、缺的是哪个文件（#38）。
    const [hasConfig, hasState] = await Promise.all([
      fileExists(join(trimmed, narracatConfigPath())),
      fileExists(join(trimmed, narracatStatePath())),
    ])
    console.error(
      '[novel-status] 项目文件不完整：',
      JSON.stringify({
        projectPath: trimmed,
        'config.yaml': hasConfig ? 'ok' : 'missing',
        'state.yaml': hasState ? 'ok' : 'missing',
      }),
    )
    throw new Error(missingProjectProblem)
  }

  const [config, state] = await Promise.all([
    readYamlFile(join(trimmed, narracatConfigPath())),
    readYamlFile(join(trimmed, narracatStatePath())),
  ])

  const currentChapter = resolveCurrentChapter(state)
  const enrichment = options.enrich
    ? await options.enrich({ projectPath: trimmed, currentChapter })
    : undefined
  const generatedAt = (options.now?.() ?? new Date()).toISOString()

  return buildNovelStatusSnapshot({ projectPath: trimmed, config, state, generatedAt, enrichment })
}

function snapshotPath(projectPath: string): string {
  return join(projectPath, narracatStatusSnapshotPath())
}

/** 读取上次落盘的状态快照；从未生成（空态）或读取失败时返回 null。 */
export async function readNovelStatusSnapshot(projectPath: string): Promise<NovelStatusSnapshot | null> {
  const trimmed = projectPath.trim()
  if (!trimmed) throw new Error('缺少项目路径。')

  try {
    const raw = await readFile(snapshotPath(trimmed), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as NovelStatusSnapshot
  } catch {
    return null
  }
}

/** 重新聚合 + 落盘 + 返回最新快照。 */
export async function refreshNovelStatusSnapshot(
  projectPath: string,
  options: NovelStatusAggregationOptions = {},
): Promise<NovelStatusSnapshot> {
  const snapshot = await aggregateNovelStatusSnapshot(projectPath, options)
  await writeFile(snapshotPath(projectPath.trim()), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8')
  return snapshot
}
