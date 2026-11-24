import { join } from 'node:path'

/**
 * Single source of truth for a Novel project's on-disk file layout — the
 * concept↔path contract (Engine contract) between the App orchestration layer
 * and the NarraCat-generated project structure.
 *
 * Pure App-layer TS: the writing Agent never calls this module, and it has zero
 * effect on prompts / Skills. Every builder returns a path RELATIVE to the
 * project root; callers join it with a concrete project path (or feed it
 * through their own path-traversal guard) as needed.
 *
 * Chapter artifacts accept both zero-padded (`ch-001`) and legacy
 * non-padded (`ch-1`) filenames; the `*Candidates` helpers expose the accepted
 * variants in resolution order, while the singular `*Path` helpers return the
 * canonical (first) variant used when writing or when no file exists yet.
 */

// --- Top-level project directories ------------------------------------------

export const NARRACAT_DIR = '.narracat'
export const BIBLE_DIR = 'bible'
export const OUTLINE_DIR = 'outline'
export const MANUSCRIPT_DIR = 'manuscript'
export const REVIEWS_DIR = 'reviews'
export const NOTES_DIR = 'notes'

const CONTEXT_PACKS_DIR = join(NARRACAT_DIR, 'context-packs')

// --- Naming primitives ------------------------------------------------------

export function volumeDirName(volume: number): string {
  return `vol-${String(volume).padStart(2, '0')}`
}

export function chapterBaseName(chapter: number): string {
  return `ch-${String(chapter).padStart(3, '0')}`
}

export function legacyChapterBaseName(chapter: number): string {
  return `ch-${chapter}`
}

export function chapterFileName(chapter: number): string {
  return `${chapterBaseName(chapter)}.md`
}

export function chapterFileNameCandidates(chapter: number): string[] {
  return [chapterFileName(chapter), `${legacyChapterBaseName(chapter)}.md`]
}

// --- .narracat system files -------------------------------------------------

export function narracatConfigPath(): string {
  return join(NARRACAT_DIR, 'config.yaml')
}

export function narracatStatePath(): string {
  return join(NARRACAT_DIR, 'state.yaml')
}

/** NovelMemory 嵌入式 SQLite 数据库（App 仅只读聚合，写入由 memory-keeper 经提交工具独占）。 */
export function narracatMemoryDbPath(): string {
  return join(NARRACAT_DIR, 'memory.db')
}

/** 工作台状态面板机械聚合快照的落盘位置。 */
export function narracatStatusSnapshotPath(): string {
  return join(NARRACAT_DIR, 'status-snapshot.json')
}

export function chapterContextPackPath(chapter: number): string {
  return join(CONTEXT_PACKS_DIR, `${chapterBaseName(chapter)}.json`)
}

export function chapterContextPackCandidates(chapter: number): string[] {
  return [chapterContextPackPath(chapter), join(CONTEXT_PACKS_DIR, `${legacyChapterBaseName(chapter)}.json`)]
}

/** 章收尾回执目录（引擎 novel_commit_chapter 落 `ch-NNN.json`）。 */
export function chapterReceiptsDir(): string {
  return join(NARRACAT_DIR, 'receipts')
}

// --- bible/ (foundation & settings) -----------------------------------------

export function premisePath(): string {
  return join(BIBLE_DIR, 'premise.md')
}

/** Structured premise data contract (ADR-0019) — DTO twin of the rendered premise.md. */
export function premiseCardsDataPath(): string {
  return join(BIBLE_DIR, 'premise-cards.json')
}

export function relationshipsPath(): string {
  return join(BIBLE_DIR, 'relationships.md')
}

export function styleGuidePath(): string {
  return join(BIBLE_DIR, 'style-guide.md')
}

export function stateVocabularyPath(): string {
  return join(BIBLE_DIR, 'state-vocabulary.json')
}

export function charactersDir(): string {
  return join(BIBLE_DIR, 'characters')
}

export function worldDir(): string {
  return join(BIBLE_DIR, 'world')
}

export function referencesDir(): string {
  return join(BIBLE_DIR, 'references')
}

export function referenceGuidanceDir(): string {
  return join(BIBLE_DIR, 'reference-guidance')
}

export function referenceGuidanceIndexPath(): string {
  return join(referenceGuidanceDir(), 'index.md')
}

export function bibleGroupDir(group: string): string {
  return join(BIBLE_DIR, group)
}

// --- outline/ ---------------------------------------------------------------

export function masterOutlinePath(): string {
  return join(OUTLINE_DIR, 'master-outline.md')
}

export function volumeOutlinePath(volume: number): string {
  return join(OUTLINE_DIR, volumeDirName(volume), 'vol-outline.md')
}

export function chapterOutlinePath(volume: number, chapter: number): string {
  return join(OUTLINE_DIR, volumeDirName(volume), chapterFileName(chapter))
}

export function chapterOutlineCandidates(volume: number, chapter: number): string[] {
  return chapterFileNameCandidates(chapter).map((name) => join(OUTLINE_DIR, volumeDirName(volume), name))
}

/** Book-level structured outline data contract (ADR-0018) — DTO twin of master-outline.md. */
export function outlineStructurePath(): string {
  return join(OUTLINE_DIR, 'outline-structure.json')
}

/** Chapter-level structured outline data contract (ADR-0018) — DTO twin of the chapter outline md. */
export function chapterOutlineDataPath(volume: number, chapter: number): string {
  return join(OUTLINE_DIR, volumeDirName(volume), `${chapterBaseName(chapter)}.json`)
}

export function chapterOutlineDataCandidates(volume: number, chapter: number): string[] {
  return [
    join(OUTLINE_DIR, volumeDirName(volume), `${chapterBaseName(chapter)}.json`),
    join(OUTLINE_DIR, volumeDirName(volume), `${legacyChapterBaseName(chapter)}.json`),
  ]
}

// --- manuscript/ ------------------------------------------------------------

export function chapterManuscriptPath(volume: number, chapter: number): string {
  return join(MANUSCRIPT_DIR, volumeDirName(volume), chapterFileName(chapter))
}

export function chapterManuscriptCandidates(volume: number, chapter: number): string[] {
  const fileNames = chapterFileNameCandidates(chapter)
  return [
    ...fileNames.map((name) => join(MANUSCRIPT_DIR, volumeDirName(volume), name)),
    ...fileNames.map((name) => join(MANUSCRIPT_DIR, name)),
  ]
}

/**
 * write 编排（一热一冷 + staging）落笔期的工作正文——引擎写作链在 promote 前把热写/打磨中的正文
 * 落在这里（三位补零，无卷子目录），中断时正式 manuscript 路径尚无文件，App 据此判「写作中断
 * （有草稿）」并提供只读预览（刀 3 §4.6）。promote 成功后引擎把文件 rename 进正式路径，本路径清空。
 */
export function chapterStagingPath(chapter: number): string {
  return join(NARRACAT_DIR, 'staging', chapterFileName(chapter))
}

// --- reviews/ ---------------------------------------------------------------

export function chapterReviewPath(chapter: number): string {
  return join(REVIEWS_DIR, `${chapterBaseName(chapter)}-review.json`)
}

export function chapterReviewCandidates(
  chapter: number,
  options: { includePlainChapterFile?: boolean } = {},
): string[] {
  const candidates = [chapterReviewPath(chapter), join(REVIEWS_DIR, `${legacyChapterBaseName(chapter)}-review.json`)]

  if (options.includePlainChapterFile) {
    candidates.push(...chapterFileNameCandidates(chapter).map((name) => join(REVIEWS_DIR, name)))
  }

  return candidates
}

/**
 * Deep-review annotation (`/review … deep`) — a finding-only human-read markdown
 * report with no verdict and no JSON twin (ADR-0021). It lives in `reviews/`
 * alongside the light-review report so the Workbench review subview surfaces both.
 */
export function chapterDeepReviewPath(chapter: number): string {
  return join(REVIEWS_DIR, `${chapterBaseName(chapter)}-deep-review.md`)
}

export function chapterDeepReviewCandidates(chapter: number): string[] {
  return [chapterDeepReviewPath(chapter), join(REVIEWS_DIR, `${legacyChapterBaseName(chapter)}-deep-review.md`)]
}

// --- Project scaffold -------------------------------------------------------

/** Directories created for a fresh Novel project, relative to its root. */
export function projectScaffoldDirectories(): string[] {
  return [
    NARRACAT_DIR,
    CONTEXT_PACKS_DIR,
    charactersDir(),
    worldDir(),
    referencesDir(),
    OUTLINE_DIR,
    MANUSCRIPT_DIR,
    REVIEWS_DIR,
    NOTES_DIR,
  ]
}
