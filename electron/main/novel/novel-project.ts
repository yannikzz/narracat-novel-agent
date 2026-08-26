import { NOVEL_PROJECT_INCOMPLETE_MESSAGE } from '@shared/lib/ipc-error'
import type { Dirent } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import { isFilledMarkdownFile } from './document-readiness'
import {
  BIBLE_DIR,
  bibleGroupDir,
  chapterManuscriptCandidates,
  chapterOutlineCandidates,
  chapterStagingPath,
  charactersDir,
  masterOutlinePath,
  narracatConfigPath,
  narracatStatePath,
  premisePath,
  referencesDir,
  relationshipsPath,
  volumeOutlinePath,
  worldDir,
} from './novel-layout'
import { parseYamlRecord, readNumber, readRecord, readString, stringifyYamlRecord } from './yaml'
import { hasNarratorVoiceSection as containsNarratorVoiceSection } from '@shared/lib/narrator-voice'
import type {
  NovelAutomationLevel,
  NovelChapterStatus,
  NovelCheckpoint,
  NovelProjectDetail,
  NovelProjectSummary,
  NovelTocItem,
  NovelWorkbenchTreeItem,
  UpdateNovelProjectMetadataInput,
} from '@shared/types/novel'

const missingProjectProblem = NOVEL_PROJECT_INCOMPLETE_MESSAGE
const corruptedStructureProblem = '全书结构数据损坏：章卷映射缺失或不完整，请让 Agent 重新同步全书结构。'
const reservedBibleDirectoryNames = new Set([
  'characters',
  'world',
  'references',
  'premise',
  'style-guide',
  'relationships',
])
const bibleGroupTitles = new Map([
  ['scenes', '场景设定'],
  ['rules', '规则设定'],
])
export const defaultNovelGenre = '未分类'
const coverPresets = [
  'cover-01',
  'cover-02',
  'cover-03',
  'cover-04',
  'cover-05',
  'cover-06',
  'cover-07',
  'cover-08',
  'cover-09',
  'cover-10',
  'cover-11',
  'cover-12',
] as const
const coverPresetIds = new Set<string>(coverPresets)
const projectDetailChapterReadConcurrency = 32

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []

  const requestedLimit = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1
  const limit = Math.max(1, Math.min(items.length, requestedLimit))
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await mapper(items[index] as T, index)
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()))
  return results
}

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

async function readYamlFile(path: string): Promise<Record<string, unknown>> {
  return parseYamlRecord(await readFile(path, 'utf-8'), path)
}

function readCompletedChapters(progress: Record<string, unknown>): number[] {
  const value = progress.completed_chapters

  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((item): item is number => Number.isInteger(item))
}

function readChapterToVolume(state: Record<string, unknown>): Map<number, number> {
  const structure = readRecord(state, 'structure')
  const raw = readRecord(structure, 'chapter_to_volume')
  const result = new Map<number, number>()

  for (const [chapterKey, volumeValue] of Object.entries(raw)) {
    const chapter = Number(chapterKey)

    if (Number.isInteger(chapter) && typeof volumeValue === 'number' && Number.isInteger(volumeValue)) {
      result.set(chapter, volumeValue)
    }
  }

  return result
}

/**
 * Structure state 矛盾检测：structure 节声明了卷/章规模，但章卷映射解析后为空或
 * 缺章（典型成因是 LLM 直写时的 YAML flow map 退化形态，见 ADR-0014）。损坏时
 * 返回 problem 文案，由 Workbench 显式呈现，不再静默渲染空卷章树。
 */
function readStructureProblem(state: Record<string, unknown>): string | undefined {
  const structure = readRecord(state, 'structure')
  const declaredVolumes = readNumber(structure, 'total_volumes') ?? 0
  const declaredChapters = readNumber(structure, 'total_chapters_planned') ?? 0
  const mappedChapters = readChapterToVolume(state).size
  const corrupted =
    (declaredChapters > 0 && mappedChapters < declaredChapters) || (declaredVolumes > 0 && mappedChapters === 0)

  return corrupted ? corruptedStructureProblem : undefined
}

export function deterministicCoverPreset(identity: string): string {
  let hash = 0

  for (let index = 0; index < identity.length; index += 1) {
    hash = (hash * 31 + identity.charCodeAt(index)) >>> 0
  }

  return coverPresets[hash % coverPresets.length]
}

function readProjectGenre(config: Record<string, unknown>): string {
  return readString(config, 'genre')?.trim() || defaultNovelGenre
}

function readProjectCoverPreset(config: Record<string, unknown>, identity: string): string {
  return (
    readString(config, 'cover_preset')?.trim() ||
    readString(config, 'coverPreset')?.trim() ||
    deterministicCoverPreset(identity)
  )
}

/**
 * 缺省/非法值一律当协作档。与引擎只对得上一半，别把这条注释读成「处处一致」：
 * `commands/plan.md` 判 `== "auto"`（`docs/contracts/new-character-intake.md` 同款），缺 key 时
 * 确实退回逐步确认，与这里一致；但 `commands/write.md` 判的是 `== "collaborative"`，缺 key 时两个
 * 分支都不命中、写作确认门根本不触发，行为等同全自动——这处引擎侧不一致要单独走引擎层修，App 侧
 * 只如实显示当前档，不在这里替引擎兜。
 * 新建（novel-create.ts）与切档（updateNovelProjectMetadata）都会写入显式值，缺 key 只出现在历史
 * 项目或被手工改过的 config.yaml 上。
 */
function readProjectAutomationLevel(config: Record<string, unknown>): NovelAutomationLevel {
  return readString(config, 'automation_level')?.trim() === 'auto' ? 'auto' : 'collaborative'
}

function normalizeMetadataTitle(title: string): string {
  const normalized = title.trim()
  if (!normalized) throw new Error('标题不能为空。')
  return normalized
}

function normalizeMetadataCoverPreset(coverPreset: string): string {
  const normalized = coverPreset.trim()
  if (!coverPresetIds.has(normalized)) throw new Error('封面预设不存在。')
  return normalized
}

function formatWordCount(total: number): string {
  if (total >= 10000) {
    return `${(total / 10000).toFixed(1)}万字`
  }

  return `${total} 字`
}

function chapterFallbackTitle(chapter: number): string {
  return `第 ${String(chapter).padStart(3, '0')} 章`
}

function formatChapterTitle(chapter: number, subtitle?: string): string {
  const fallback = chapterFallbackTitle(chapter)
  return subtitle ? `${fallback} · ${subtitle}` : fallback
}

async function readChapterSubtitle(
  projectPath: string,
  volume: number,
  chapter: number,
): Promise<string | undefined> {
  const paths = chapterOutlineCandidates(volume, chapter).map((relativePath) => join(projectPath, relativePath))

  for (const path of paths) {
    try {
      const raw = await readFile(path, 'utf-8')
      const heading = raw.split('\n').find((line) => line.startsWith('# '))

      if (!heading) {
        return undefined
      }

      // 兼容产出漂移：标题里紧跟章号的「大纲/细纲/章纲」是文档类型字样，不是章名
      // （如 `# 第3章大纲：只有计划表`）。仅在其后跟冒号时剥除，避免误伤
      // `# 第3章: 大纲之外` 这类真实以「大纲」开头的章名。
      const title = heading
        .replace(/^#\s*/, '')
        .replace(/^第\s*\d+\s*章\s*(?:(?:大纲|细纲|章纲)\s*[:：]|[:：])?\s*/, '')
        .trim()

      return title || undefined
    } catch {
      // Try the next accepted NarraCat filename variant.
    }
  }

  return undefined
}

async function getUpdatedAt(projectPath: string): Promise<string | undefined> {
  try {
    const info = await stat(join(projectPath, narracatStatePath()))
    return info.mtime.toISOString()
  } catch {
    return undefined
  }
}

function readCheckpoint(state: Record<string, unknown>): NovelCheckpoint | null {
  const checkpoint = readRecord(state, 'checkpoint')
  const lastCommand = checkpoint.last_command

  if (lastCommand === null || lastCommand === undefined) {
    return null
  }

  return {
    lastCommand: typeof lastCommand === 'string' ? lastCommand : null,
    lastStep: readNumber(checkpoint, 'last_step') ?? null,
    timestamp: readString(checkpoint, 'timestamp') ?? null,
  }
}

function readFiniteInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = readNumber(record, key)
  return Number.isInteger(value) ? value : undefined
}

function isWriteCheckpointCommand(command: string | null | undefined): boolean {
  if (!command) return false
  const normalized = command.trim()
  return (
    normalized === 'write' ||
    normalized.startsWith('write ') ||
    normalized === '/narracat:write' ||
    normalized.startsWith('/narracat:write ')
  )
}

function readWriteCheckpointChapter(command: string | null | undefined): number | undefined {
  if (!command) return undefined
  const match = /^(?:\/narracat:)?write\s+(\d+)$/.exec(command.trim())
  if (!match) return undefined
  const chapter = Number(match[1])
  return Number.isSafeInteger(chapter) && chapter > 0 ? chapter : undefined
}

function readInProgressChapter(state: Record<string, unknown>, progress: Record<string, unknown>): number | undefined {
  return readFiniteInteger(progress, 'in_progress_chapter') ?? readFiniteInteger(state, 'in_progress_chapter')
}

function readRecoverableWriteChapter(
  state: Record<string, unknown>,
  progress: Record<string, unknown>,
  completed: Set<number>,
): number | undefined {
  const checkpoint = readCheckpoint(state)
  if (!isWriteCheckpointCommand(checkpoint?.lastCommand)) return undefined
  const chapter =
    readInProgressChapter(state, progress) ?? readWriteCheckpointChapter(checkpoint?.lastCommand)
  if (!chapter || completed.has(chapter)) return undefined

  return chapter
}

async function directMarkdownFiles(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => join(path, entry.name))
  } catch {
    return []
  }
}

async function directTextFiles(
  projectPath: string,
  relativeDir: string,
  extensions: string[],
): Promise<string[]> {
  try {
    const entries = await readdir(join(projectPath, relativeDir), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && extensions.includes(extname(entry.name).toLowerCase()))
      .map((entry) => join(relativeDir, entry.name))
      .sort((left, right) => left.localeCompare(right, 'zh-CN'))
  } catch {
    return []
  }
}

function titleFromFilePath(path: string): string {
  return basename(path).replace(/\.[^.]+$/, '')
}

function firstMarkdownHeading(content: string): string | null {
  for (const line of content.split('\n')) {
    const match = /^\s{0,3}#\s+(.+?)\s*#*\s*$/.exec(line)
    const title = match?.[1]?.trim()
    if (title) return title
  }

  return null
}

// 世界观文档常以英文 slug 命名（如 jianghu-rules.md），目录条目展示文档内的中文首标题；
// id 仍绑定文件名（用于回溯定位文件），读不到内容时回退文件名。
async function worldDocumentTitle(projectPath: string, relativePath: string): Promise<string> {
  const stem = titleFromFilePath(relativePath)
  try {
    return firstMarkdownHeading(await readFile(join(projectPath, relativePath), 'utf-8')) ?? stem
  } catch {
    return stem
  }
}

function titleFromBibleDirectory(dirName: string): string {
  const fallback = dirName.replace(/[-_]+/g, ' ').trim() || dirName
  return bibleGroupTitles.get(dirName) ?? fallback
}

async function hasAnyNonEmptyDirectTextFile(
  projectPath: string,
  relativeDir: string,
): Promise<boolean> {
  const files = await directTextFiles(projectPath, relativeDir, ['.md', '.txt'])

  for (const file of files) {
    try {
      if ((await readFile(join(projectPath, file), 'utf-8')).trim().length > 0) {
        return true
      }
    } catch {
      // Ignore files that disappear between readdir and readFile.
    }
  }

  return false
}

async function dynamicBibleGroupItems(projectPath: string): Promise<NovelWorkbenchTreeItem[]> {
  let entries: Dirent[]

  try {
    entries = await readdir(join(projectPath, BIBLE_DIR), { withFileTypes: true })
  } catch {
    return []
  }

  const dirNames = entries
    .filter((entry) => entry.isDirectory() && !reservedBibleDirectoryNames.has(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))

  return Promise.all(
    dirNames.map(async (dirName) => {
      const relativePath = bibleGroupDir(dirName)

      return {
        id: `bible-${dirName}`,
        kind: 'bible-group',
        title: titleFromBibleDirectory(dirName),
        level: 1,
        parentId: 'foundation',
        path: relativePath,
        exists: await hasAnyNonEmptyDirectTextFile(projectPath, relativePath),
      }
    }),
  )
}

async function hasAnyFilledMarkdownFile(path: string): Promise<boolean> {
  const files = await directMarkdownFiles(path)

  for (const file of files) {
    if (await isFilledMarkdownFile(file)) {
      return true
    }
  }

  return false
}

async function hasNarratorVoiceSection(path: string): Promise<boolean> {
  try {
    return containsNarratorVoiceSection(await readFile(path, 'utf-8'))
  } catch {
    return false
  }
}

export async function hasNovelSetupData(projectPath: string): Promise<boolean> {
  return isFilledMarkdownFile(join(projectPath, premisePath()))
}

async function resolveChapterStatus(
  projectPath: string,
  volume: number,
  chapter: number,
  completed: Set<number>,
  inProgress: unknown,
  recoverableWriteChapter: number | undefined,
): Promise<NovelChapterStatus> {
  if (completed.has(chapter)) {
    const manuscriptExists = await hasAnyFile(
      chapterManuscriptCandidates(volume, chapter).map((relativePath) => join(projectPath, relativePath)),
    )
    return manuscriptExists ? 'completed' : 'missing-manuscript'
  }

  if (recoverableWriteChapter === chapter) {
    return 'recoverable'
  }

  if (inProgress === chapter) {
    return 'in-progress'
  }

  // write 编排（一热一冷 + staging）中断：正式正文缺失但热写/打磨中的草稿留在 staging，
  // 未走完 promote。既非 completed 也非 recoverable/in-progress 时，才降级到这个只读预览态。
  if (await isFile(join(projectPath, chapterStagingPath(chapter)))) {
    return 'interrupted-draft'
  }

  const outlineExists = await hasAnyFile(
    chapterOutlineCandidates(volume, chapter).map((relativePath) => join(projectPath, relativePath)),
  )
  return outlineExists ? 'planned' : 'missing-outline'
}

async function hasAnyFile(paths: string[]): Promise<boolean> {
  for (const path of paths) {
    if (await isFile(path)) return true
  }

  return false
}

/**
 * 精确「已写章」集合（state.yaml completed 集合 ∩ 正文文件存在，同 resolveChapterStatus 的
 * completed+hasAnyFile 口径）——供角色未来计划轻提示等消费端判定"未写章"，别复制粘贴。
 *
 * fail-safe：state.yaml 缺失/解析失败按空集合返回（宁可少滤别抛错，调用方据此判定的
 * "未写章"会偏多，即少滤=多显示的安全方向）。
 */
export async function readWrittenChapterSet(projectPath: string): Promise<Set<number>> {
  try {
    const state = await readYamlFile(join(projectPath, narracatStatePath()))
    const progress = readRecord(state, 'progress')
    const completedChapters = readCompletedChapters(progress)
    const chapterToVolume = readChapterToVolume(state)

    const written = new Set<number>()
    await Promise.all(
      completedChapters.map(async (chapter) => {
        const volume = chapterToVolume.get(chapter) ?? 1
        const exists = await hasAnyFile(
          chapterManuscriptCandidates(volume, chapter).map((relativePath) => join(projectPath, relativePath)),
        )
        if (exists) written.add(chapter)
      }),
    )
    return written
  } catch {
    return new Set()
  }
}

export async function isNarraCatProject(projectPath: string): Promise<boolean> {
  const configPath = join(projectPath, narracatConfigPath())
  const statePath = join(projectPath, narracatStatePath())

  return (await isFile(configPath)) && (await isFile(statePath))
}

async function buildWorkbenchTreeItems(
  projectPath: string,
  tocItems: NovelTocItem[],
): Promise<NovelWorkbenchTreeItem[]> {
  const masterOutlineRelativePath = masterOutlinePath()
  const premiseRelativePath = premisePath()
  const relationshipsRelativePath = relationshipsPath()
  const characterFiles = await directTextFiles(projectPath, charactersDir(), ['.md'])
  const worldFiles = await directTextFiles(projectPath, worldDir(), ['.md'])
  const narratorVoiceExists = await hasNarratorVoiceSection(join(projectPath, masterOutlineRelativePath))
  const referenceFiles = await directTextFiles(projectPath, referencesDir(), ['.md', '.txt'])
  const dynamicBibleGroups = await dynamicBibleGroupItems(projectPath)
  const worldItems: NovelWorkbenchTreeItem[] = await Promise.all(
    worldFiles.map(async (path) => ({
      id: `world-${titleFromFilePath(path)}`,
      kind: 'world' as const,
      title: await worldDocumentTitle(projectPath, path),
      level: 2,
      parentId: 'world',
      path,
      exists: true,
    })),
  )
  const items: NovelWorkbenchTreeItem[] = [
    {
      id: 'master-outline',
      kind: 'master-outline',
      title: '全书大纲',
      level: 0,
      path: masterOutlineRelativePath,
      exists: await isFile(join(projectPath, masterOutlineRelativePath)),
    },
    { id: 'foundation', kind: 'foundation', title: '创作根基', level: 0 },
    {
      id: 'bible-premise',
      kind: 'bible-document',
      title: '核心前提',
      level: 1,
      parentId: 'foundation',
      path: premiseRelativePath,
      exists: await isFilledMarkdownFile(join(projectPath, premiseRelativePath)),
    },
    {
      id: 'world',
      kind: 'world-list',
      title: '世界观',
      level: 1,
      parentId: 'foundation',
      exists: await hasAnyFilledMarkdownFile(join(projectPath, worldDir())),
    },
    ...worldItems,
    {
      id: 'characters',
      kind: 'character-list',
      title: '小说角色',
      level: 1,
      parentId: 'foundation',
      exists: await hasAnyFilledMarkdownFile(join(projectPath, charactersDir())),
    },
    ...characterFiles.map((path) => ({
      id: `character-${titleFromFilePath(path)}`,
      kind: 'character' as const,
      title: titleFromFilePath(path),
      level: 2,
      parentId: 'characters',
      path,
      exists: true,
    })),
    {
      id: 'bible-relationships',
      kind: 'bible-document',
      title: '关系设定',
      level: 1,
      parentId: 'foundation',
      path: relationshipsRelativePath,
      exists: await isFilledMarkdownFile(join(projectPath, relationshipsRelativePath)),
    },
    ...(narratorVoiceExists
      ? [
          {
            id: 'narrator-voice',
            kind: 'narrator-voice' as const,
            title: '叙事声音',
            level: 1,
            parentId: 'foundation',
            path: masterOutlineRelativePath,
            exists: true,
          },
        ]
      : []),
    {
      id: 'references',
      kind: 'reference-list',
      title: '参考作品',
      level: 0,
      exists: referenceFiles.length > 0,
    },
    ...dynamicBibleGroups,
  ]

  for (const item of tocItems) {
    if (item.kind === 'volume') {
      const volumeNumber = item.volumeNumber ?? 1
      const outlinePath = volumeOutlinePath(volumeNumber)

      items.push({
        id: item.id,
        kind: 'volume',
        title: item.title,
        level: 0,
        volumeNumber,
      })
      items.push({
        id: `volume-outline-${volumeNumber}`,
        kind: 'volume-outline',
        title: '卷大纲',
        level: 1,
        parentId: item.id,
        volumeNumber,
        path: outlinePath,
        exists: await isFile(join(projectPath, outlinePath)),
      })
      continue
    }

    items.push({
      id: item.id,
      kind: 'chapter',
      title: item.title,
      level: 1,
      parentId: `volume-${item.volumeNumber}`,
      chapterNumber: item.chapterNumber,
      volumeNumber: item.volumeNumber,
      status: item.status,
    })
  }

  return items
}

export async function loadNovelProjectSummary(projectPath: string): Promise<NovelProjectSummary> {
  if (!(await isNarraCatProject(projectPath))) {
    return {
      id: projectPath,
      title: basename(projectPath) || projectPath,
      genre: defaultNovelGenre,
      coverPreset: deterministicCoverPreset(projectPath),
      path: projectPath,
      status: 'invalid',
      chapterProgress: '0 / 0 章',
      wordCountLabel: '0 字',
      problem: missingProjectProblem,
    }
  }

  const config = await readYamlFile(join(projectPath, narracatConfigPath()))
  const state = await readYamlFile(join(projectPath, narracatStatePath()))
  const progress = readRecord(state, 'progress')
  const structure = readRecord(state, 'structure')
  const wordCount = readRecord(state, 'word_count')
  const completedChapters = readCompletedChapters(progress)
  const completed = completedChapters.length
  const completedSet = new Set(completedChapters)
  const planned = Math.max(
    readNumber(progress, 'total_chapters_planned') ?? 0,
    readNumber(structure, 'total_chapters_planned') ?? 0,
  )
  const inProgress =
    readFiniteInteger(progress, 'in_progress_chapter') ?? readRecoverableWriteChapter(state, progress, completedSet)
  const status =
    inProgress === undefined
      ? planned > 0
        ? 'ready'
        : (await hasNovelSetupData(projectPath))
          ? 'needs-outline'
          : 'needs-setup'
      : 'in-progress'

  const id = readString(config, 'novel_id') ?? projectPath
  const structureProblem = readStructureProblem(state)

  return {
    id,
    title: (readString(config, 'title') ?? basename(projectPath)) || '未命名小说',
    genre: readProjectGenre(config),
    coverPreset: readProjectCoverPreset(config, id),
    automationLevel: readProjectAutomationLevel(config),
    path: projectPath,
    status,
    chapterProgress: `${completed} / ${planned} 章`,
    wordCountLabel: formatWordCount(readNumber(wordCount, 'total') ?? 0),
    wordCountTotal: readNumber(wordCount, 'total') ?? 0,
    updatedAt: await getUpdatedAt(projectPath),
    checkpoint: readCheckpoint(state),
    ...(structureProblem ? { problem: structureProblem } : {}),
  }
}

export async function loadNovelProjectDetail(
  projectPath: string,
  selectedChapter?: number,
): Promise<NovelProjectDetail> {
  const summary = await loadNovelProjectSummary(projectPath)

  if (summary.status === 'invalid') {
    return { ...summary, tocItems: [], treeItems: [], selectedChapter, checkpoint: null }
  }

  const state = await readYamlFile(join(projectPath, narracatStatePath()))
  const progress = readRecord(state, 'progress')
  const completed = new Set(readCompletedChapters(progress))
  const chapterToVolume = readChapterToVolume(state)
  const firstChapter = [...chapterToVolume.keys()].sort((a, b) => a - b)[0]
  const inProgressChapter = readFiniteInteger(progress, 'in_progress_chapter')
  const recoverableWriteChapter = readRecoverableWriteChapter(state, progress, completed)
  const activeChapter =
    selectedChapter ??
    recoverableWriteChapter ??
    inProgressChapter ??
    readFiniteInteger(progress, 'last_completed_chapter') ??
    firstChapter
  const volumes = [...new Set(chapterToVolume.values())].sort((a, b) => a - b)
  const tocItems: NovelTocItem[] = []

  for (const volume of volumes) {
    tocItems.push({
      id: `volume-${volume}`,
      kind: 'volume',
      title: `第 ${volume} 卷`,
      volumeNumber: volume,
    })

    const chapters = [...chapterToVolume.entries()]
      .filter(([, chapterVolume]) => chapterVolume === volume)
      .map(([chapter]) => chapter)
      .sort((a, b) => a - b)

    const chapterItems = await mapWithConcurrency(chapters, projectDetailChapterReadConcurrency, async (chapter) => {
      const [subtitle, status] = await Promise.all([
        readChapterSubtitle(projectPath, volume, chapter),
        resolveChapterStatus(projectPath, volume, chapter, completed, inProgressChapter, recoverableWriteChapter),
      ])

      return {
        id: `chapter-${chapter}`,
        kind: 'chapter' as const,
        title: formatChapterTitle(chapter, subtitle),
        chapterNumber: chapter,
        volumeNumber: volume,
        status,
        active: chapter === activeChapter,
      }
    })

    tocItems.push(...chapterItems)
  }

  const treeItems = await buildWorkbenchTreeItems(projectPath, tocItems)

  return {
    ...summary,
    tocItems,
    treeItems,
    selectedChapter: activeChapter,
    checkpoint: readCheckpoint(state),
  }
}

export async function updateNovelProjectMetadata(
  input: UpdateNovelProjectMetadataInput,
): Promise<NovelProjectDetail> {
  const projectPath = input.projectPath.trim()
  if (!projectPath) throw new Error('缺少项目路径。')
  if (!(await isNarraCatProject(projectPath))) throw new Error(missingProjectProblem)

  const configPath = join(projectPath, narracatConfigPath())
  const config = await readYamlFile(configPath)
  let changed = false

  if (input.title !== undefined) {
    config.title = normalizeMetadataTitle(input.title)
    changed = true
  }

  if (input.coverPreset !== undefined) {
    config.cover_preset = normalizeMetadataCoverPreset(input.coverPreset)
    changed = true
  }

  if (input.automationLevel !== undefined) {
    config.automation_level = input.automationLevel
    changed = true
  }

  if (!changed) throw new Error('没有可更新的小说信息。')

  await writeFile(configPath, stringifyYamlRecord(config), 'utf-8')
  return loadNovelProjectDetail(projectPath)
}
