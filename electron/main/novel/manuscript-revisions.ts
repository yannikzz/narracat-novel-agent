import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import type {
  ManuscriptRevisionContent,
  ManuscriptRevisionEntry,
  ManuscriptRevisionInput,
  ManuscriptRevisionList,
  ManuscriptRevisionSource,
  ReadManuscriptRevisionInput,
  RestoreManuscriptRevisionInput,
} from '@shared/types/manuscript-revision'
import { atomicWriteFile } from '../atomic-write.ts'
import { manuscriptTextHash, normalizeManuscriptText, readVisibleManuscriptText } from './manuscript-file.ts'
import { NARRACAT_DIR } from './novel-layout.ts'
import { isNarraCatProject, loadNovelProjectSummary } from './novel-project.ts'

const gzipAsync = promisify(gzip) as (input: string | Uint8Array) => Promise<Buffer>
const gunzipAsync = promisify(gunzip) as (input: Uint8Array) => Promise<Buffer>
const REVISION_ID_RE = /^rev-[a-f0-9-]{36}$/
const HASH_RE = /^[a-f0-9]{64}$/
const SCHEMA_VERSION = 1
const REVISION_SOURCES = new Set<ManuscriptRevisionSource>([
  'author-save',
  'agent-write',
  'agent-rewrite',
  'revision-restore',
  'llm-polish',
])

interface ManuscriptRevisionRecordV1 {
  id: string
  chapter: number
  source: ManuscriptRevisionSource
  createdAt: string
  beforeHash?: string
  afterHash: string
  summary: {
    addedChars: number
    removedChars: number
  }
}

interface ManuscriptRevisionIndexV1 {
  schemaVersion: 1
  novelId: string
  revisions: ManuscriptRevisionRecordV1[]
}

interface ManuscriptRevisionPendingV1 {
  schemaVersion: 1
  id: string
  novelId: string
  chapter: number
  source: ManuscriptRevisionSource
  createdAt: string
  beforeHash?: string
  runId?: string
  ownerInstanceId: string
  settledAt?: string
}

export interface BeginManuscriptRevisionInput {
  projectPath: string
  chapter: number
  source: ManuscriptRevisionSource
  /**
   * 已由调用方读到的变更前可见正文。undefined 时由 store 读盘，null 表示正文尚不存在。
   */
  beforeVisibleText?: string | null
  runId?: string
}

export interface CompleteManuscriptRevisionInput {
  projectPath: string
  revisionId: string
  /** undefined 时由 store 读盘，null 表示正文已不存在。 */
  afterVisibleText?: string | null
}

export interface AbortManuscriptRevisionInput {
  projectPath: string
  revisionId: string
}

export interface ManuscriptRevisionCapture {
  revisionId: string
}

export interface ManuscriptRevisionStore {
  begin: (input: BeginManuscriptRevisionInput) => Promise<ManuscriptRevisionCapture>
  complete: (input: CompleteManuscriptRevisionInput) => Promise<ManuscriptRevisionEntry | null>
  abort: (input: AbortManuscriptRevisionInput) => Promise<void>
  listChapter: (input: ManuscriptRevisionInput) => Promise<ManuscriptRevisionList>
  readRevision: (input: ReadManuscriptRevisionInput) => Promise<ManuscriptRevisionContent>
}

export interface ManuscriptRevisionStoreOptions {
  now?: () => string
  createRevisionId?: () => string
  instanceId?: string
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function asProjectPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) throw new Error('项目路径参数非法。')
  return resolve(value)
}

function asChapter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error('章号参数非法。')
  return value
}

function asRevisionId(value: unknown): string {
  if (typeof value !== 'string' || !REVISION_ID_RE.test(value)) throw new Error('正文版本参数非法。')
  return value
}

function asText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}参数非法。`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value)
}

function isSource(value: unknown): value is ManuscriptRevisionSource {
  return typeof value === 'string' && REVISION_SOURCES.has(value as ManuscriptRevisionSource)
}

function assertSupportedSchema(value: unknown): void {
  if (isRecord(value) && typeof value.schemaVersion === 'number' && value.schemaVersion > SCHEMA_VERSION) {
    throw new Error('当前正文版本历史由更新版本的 NarraCat 创建，请先更新 App。')
  }
}

function isRevisionRecord(value: unknown): value is ManuscriptRevisionRecordV1 {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    REVISION_ID_RE.test(value.id) &&
    typeof value.chapter === 'number' &&
    Number.isInteger(value.chapter) &&
    value.chapter > 0 &&
    isSource(value.source) &&
    typeof value.createdAt === 'string' &&
    (value.beforeHash === undefined || isHash(value.beforeHash)) &&
    isHash(value.afterHash) &&
    isRecord(value.summary) &&
    typeof value.summary.addedChars === 'number' &&
    Number.isSafeInteger(value.summary.addedChars) &&
    value.summary.addedChars >= 0 &&
    typeof value.summary.removedChars === 'number' &&
    Number.isSafeInteger(value.summary.removedChars) &&
    value.summary.removedChars >= 0
  )
}

function isRevisionIndex(value: unknown, novelId: string): value is ManuscriptRevisionIndexV1 {
  assertSupportedSchema(value)
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.novelId === novelId &&
    Array.isArray(value.revisions) &&
    value.revisions.every(isRevisionRecord)
  )
}

function isPending(value: unknown, novelId: string, revisionId?: string): value is ManuscriptRevisionPendingV1 {
  assertSupportedSchema(value)
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.novelId === novelId &&
    typeof value.id === 'string' &&
    REVISION_ID_RE.test(value.id) &&
    (revisionId === undefined || value.id === revisionId) &&
    typeof value.chapter === 'number' &&
    Number.isInteger(value.chapter) &&
    value.chapter > 0 &&
    isSource(value.source) &&
    typeof value.createdAt === 'string' &&
    (value.beforeHash === undefined || isHash(value.beforeHash)) &&
    (value.runId === undefined || typeof value.runId === 'string') &&
    typeof value.ownerInstanceId === 'string' &&
    Boolean(value.ownerInstanceId) &&
    (value.settledAt === undefined || typeof value.settledAt === 'string')
  )
}

function revisionRoot(projectPath: string): string {
  return join(projectPath, NARRACAT_DIR, 'manuscript-revisions')
}

function indexPath(projectPath: string): string {
  return join(revisionRoot(projectPath), 'index.json')
}

function blobPath(projectPath: string, hash: string): string {
  return join(revisionRoot(projectPath), 'blobs', `${hash}.txt.gz`)
}

function pendingPath(projectPath: string, revisionId: string): string {
  return join(revisionRoot(projectPath), 'pending', `${revisionId}.json`)
}

async function requireProjectIdentity(projectPath: string): Promise<string> {
  if (!(await isNarraCatProject(projectPath))) throw new Error('这不是有效的 NarraCat 小说项目。')
  const summary = await loadNovelProjectSummary(projectPath)
  if (summary.status === 'invalid') throw new Error(summary.problem ?? '小说项目不可用。')
  return summary.id
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function toEntry(record: ManuscriptRevisionRecordV1): ManuscriptRevisionEntry {
  return {
    id: record.id,
    chapter: record.chapter,
    source: record.source,
    createdAt: record.createdAt,
    summary: { ...record.summary },
  }
}

function summarizeChange(beforeText: string, afterText: string): { addedChars: number; removedChars: number } {
  const before = normalizeManuscriptText(beforeText)
  const after = normalizeManuscriptText(afterText)
  let prefix = 0
  const prefixLimit = Math.min(before.length, after.length)
  while (prefix < prefixLimit && before[prefix] === after[prefix]) prefix += 1

  let suffix = 0
  const suffixLimit = Math.min(before.length - prefix, after.length - prefix)
  while (
    suffix < suffixLimit &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1
  }

  return {
    addedChars: after.length - prefix - suffix,
    removedChars: before.length - prefix - suffix,
  }
}

async function directorySize(path: string): Promise<number> {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isMissingFileError(error)) return 0
    throw error
  }

  let total = 0
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      total += await directorySize(child)
    } else {
      total += (await lstat(child)).size
    }
  }
  return total
}

export function parseManuscriptRevisionInput(input: unknown): ManuscriptRevisionInput {
  const raw = (input ?? {}) as Record<string, unknown>
  return {
    projectPath: asProjectPath(raw.projectPath),
    chapter: asChapter(raw.chapter),
  }
}

export function parseReadManuscriptRevisionInput(input: unknown): ReadManuscriptRevisionInput {
  const raw = (input ?? {}) as Record<string, unknown>
  return {
    ...parseManuscriptRevisionInput(raw),
    revisionId: asRevisionId(raw.revisionId),
  }
}

export function parseRestoreManuscriptRevisionInput(input: unknown): RestoreManuscriptRevisionInput {
  const raw = (input ?? {}) as Record<string, unknown>
  return {
    ...parseReadManuscriptRevisionInput(raw),
    expectedVisibleText: asText(raw.expectedVisibleText, '当前正文'),
  }
}

export function createManuscriptRevisionStore(
  options: ManuscriptRevisionStoreOptions = {},
): ManuscriptRevisionStore {
  const now = options.now ?? (() => new Date().toISOString())
  const createRevisionId = options.createRevisionId ?? (() => `rev-${randomUUID()}`)
  const instanceId = options.instanceId ?? randomUUID()
  const queues = new Map<string, Promise<unknown>>()
  const activeCaptureIds = new Set<string>()

  function enqueue<T>(projectPath: string, operation: () => Promise<T>): Promise<T> {
    const key = resolve(projectPath)
    const previous = queues.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    queues.set(key, current)
    return current.finally(() => {
      if (queues.get(key) === current) queues.delete(key)
    })
  }

  async function readIndex(projectPath: string, novelId: string): Promise<ManuscriptRevisionIndexV1> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(indexPath(projectPath), 'utf-8'))
    } catch (error) {
      if (isMissingFileError(error)) return { schemaVersion: 1, novelId, revisions: [] }
      throw new Error('正文版本历史索引损坏。', { cause: error })
    }
    if (!isRevisionIndex(parsed, novelId)) throw new Error('正文版本历史索引损坏。')
    return parsed
  }

  async function writeIndex(projectPath: string, index: ManuscriptRevisionIndexV1): Promise<void> {
    await mkdir(revisionRoot(projectPath), { recursive: true })
    await atomicWriteFile(indexPath(projectPath), serialize(index))
  }

  async function writeBlob(projectPath: string, visibleText: string): Promise<string> {
    const normalized = normalizeManuscriptText(visibleText)
    const hash = manuscriptTextHash(normalized)
    const path = blobPath(projectPath, hash)
    try {
      await lstat(path)
      return hash
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    await mkdir(join(revisionRoot(projectPath), 'blobs'), { recursive: true })
    await atomicWriteFile(path, await gzipAsync(Buffer.from(normalized, 'utf-8')))
    return hash
  }

  async function readBlob(projectPath: string, hash: string): Promise<string> {
    let compressed: Buffer
    try {
      compressed = await readFile(blobPath(projectPath, hash))
    } catch (error) {
      throw new Error('正文版本内容缺失或不可读取。', { cause: error })
    }
    let visibleText: string
    try {
      visibleText = (await gunzipAsync(compressed)).toString('utf-8')
    } catch (error) {
      throw new Error('正文版本内容损坏。', { cause: error })
    }
    if (manuscriptTextHash(visibleText) !== hash) throw new Error('正文版本内容校验失败。')
    return visibleText
  }

  async function readPending(
    projectPath: string,
    novelId: string,
    revisionId: string,
  ): Promise<ManuscriptRevisionPendingV1 | null> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(pendingPath(projectPath, revisionId), 'utf-8'))
    } catch (error) {
      if (isMissingFileError(error)) return null
      throw new Error('正文版本待完成记录损坏。', { cause: error })
    }
    if (!isPending(parsed, novelId, revisionId)) throw new Error('正文版本待完成记录损坏。')
    return parsed
  }

  async function completePending(
    projectPath: string,
    novelId: string,
    pending: ManuscriptRevisionPendingV1,
    afterVisibleText: string | null | undefined,
  ): Promise<ManuscriptRevisionEntry | null> {
    const index = await readIndex(projectPath, novelId)
    const completed = index.revisions.find((revision) => revision.id === pending.id)
    if (completed) {
      await rm(pendingPath(projectPath, pending.id), { force: true })
      return toEntry(completed)
    }

    const after =
      afterVisibleText === undefined
        ? await readVisibleManuscriptText(projectPath, pending.chapter)
        : afterVisibleText
    if (after === null) {
      await rm(pendingPath(projectPath, pending.id), { force: true })
      return null
    }
    const normalizedAfter = normalizeManuscriptText(after)
    const afterHash = manuscriptTextHash(normalizedAfter)
    if (pending.beforeHash === afterHash) {
      await rm(pendingPath(projectPath, pending.id), { force: true })
      return null
    }

    await writeBlob(projectPath, normalizedAfter)
    const beforeText = pending.beforeHash ? await readBlob(projectPath, pending.beforeHash) : ''
    const record: ManuscriptRevisionRecordV1 = {
      id: pending.id,
      chapter: pending.chapter,
      source: pending.source,
      createdAt: pending.createdAt,
      ...(pending.beforeHash ? { beforeHash: pending.beforeHash } : {}),
      afterHash,
      summary: summarizeChange(beforeText, normalizedAfter),
    }
    index.revisions.push(record)
    await writeIndex(projectPath, index)
    await rm(pendingPath(projectPath, pending.id), { force: true })
    return toEntry(record)
  }

  async function reconcilePending(projectPath: string, novelId: string): Promise<void> {
    let names: string[]
    try {
      names = await readdir(join(revisionRoot(projectPath), 'pending'))
    } catch (error) {
      if (isMissingFileError(error)) return
      throw error
    }

    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const revisionId = name.slice(0, -'.json'.length)
      if (!REVISION_ID_RE.test(revisionId)) throw new Error('正文版本待完成记录包含非法文件。')
      const pending = await readPending(projectPath, novelId, revisionId)
      // 同一 App 实例仍持有且尚未 settle 的 capture 可能对应 Agent 正在写入的中间态；
      // 读取历史不能把部分正文提前固化。跨进程启动或已 settle 的 pending 才允许恢复。
      if (pending && (!activeCaptureIds.has(pending.id) || pending.settledAt)) {
        await completePending(projectPath, novelId, pending, undefined)
      }
    }
  }

  return {
    begin(input) {
      const projectPath = asProjectPath(input.projectPath)
      const chapter = asChapter(input.chapter)
      if (!isSource(input.source)) throw new Error('正文版本来源参数非法。')
      return enqueue(projectPath, async () => {
        const novelId = await requireProjectIdentity(projectPath)
        await reconcilePending(projectPath, novelId)
        const revisionId = createRevisionId()
        if (!REVISION_ID_RE.test(revisionId)) throw new Error('正文版本 ID 生成失败。')
        const before =
          input.beforeVisibleText === undefined
            ? await readVisibleManuscriptText(projectPath, chapter)
            : input.beforeVisibleText
        const beforeHash = before === null ? undefined : await writeBlob(projectPath, before)
        const pending: ManuscriptRevisionPendingV1 = {
          schemaVersion: 1,
          id: revisionId,
          novelId,
          chapter,
          source: input.source,
          createdAt: now(),
          ...(beforeHash ? { beforeHash } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
          ownerInstanceId: instanceId,
        }
        await mkdir(join(revisionRoot(projectPath), 'pending'), { recursive: true })
        await atomicWriteFile(pendingPath(projectPath, revisionId), serialize(pending))
        activeCaptureIds.add(revisionId)
        return { revisionId }
      })
    },

    complete(input) {
      const projectPath = asProjectPath(input.projectPath)
      const revisionId = asRevisionId(input.revisionId)
      return enqueue(projectPath, async () => {
        try {
          const novelId = await requireProjectIdentity(projectPath)
          const pending = await readPending(projectPath, novelId, revisionId)
          if (!pending) {
            const existing = (await readIndex(projectPath, novelId)).revisions.find(
              (revision) => revision.id === revisionId,
            )
            return existing ? toEntry(existing) : null
          }
          const settled = { ...pending, settledAt: now() }
          await atomicWriteFile(pendingPath(projectPath, revisionId), serialize(settled))
          return completePending(projectPath, novelId, settled, input.afterVisibleText)
        } finally {
          // 调用方已经声明本次写入 settle。即使完成索引前失败，后续 list/read/begin 也应能在
          // 同一 App 进程内接管 pending，而不是必须等到重启后才恢复。
          activeCaptureIds.delete(revisionId)
        }
      })
    },

    abort(input) {
      const projectPath = asProjectPath(input.projectPath)
      const revisionId = asRevisionId(input.revisionId)
      return enqueue(projectPath, async () => {
        try {
          await requireProjectIdentity(projectPath)
          await rm(pendingPath(projectPath, revisionId), { force: true })
        } finally {
          activeCaptureIds.delete(revisionId)
        }
      })
    },

    listChapter(input) {
      const projectPath = asProjectPath(input.projectPath)
      const chapter = asChapter(input.chapter)
      return enqueue(projectPath, async () => {
        const novelId = await requireProjectIdentity(projectPath)
        await reconcilePending(projectPath, novelId)
        const index = await readIndex(projectPath, novelId)
        // 列表是「可回到的状态集合」，不是操作流水——按可恢复内容去重，同一份内容只留最早
        // 那条（创造出这个状态的那次写入，标签与时间才对得上）。
        //
        // 不去重就会出现同一版列两行：首次 agent-write 没有 before，回落取 after（= A）；
        // 而紧随其后那次写入的 before 也正是 A。两种语义撞在一起，作者点哪一行 diff 都一样，
        // 看起来就是「版本历史没保留任何东西」。真机撞出来的。
        const byContent = new Map<string, ManuscriptRevisionRecordV1>()
        for (const revision of index.revisions.filter((item) => item.chapter === chapter)) {
          const contentHash = revision.beforeHash ?? revision.afterHash
          const kept = byContent.get(contentHash)
          if (!kept || revision.createdAt < kept.createdAt) byContent.set(contentHash, revision)
        }
        const revisions = [...byContent.values()]
          .sort((left, right) => {
            const byTime = right.createdAt.localeCompare(left.createdAt)
            return byTime === 0 ? right.id.localeCompare(left.id) : byTime
          })
          .map(toEntry)
        return {
          revisions,
          storageBytes: await directorySize(revisionRoot(projectPath)),
        }
      })
    },

    readRevision(input) {
      const projectPath = asProjectPath(input.projectPath)
      const chapter = asChapter(input.chapter)
      const revisionId = asRevisionId(input.revisionId)
      return enqueue(projectPath, async () => {
        const novelId = await requireProjectIdentity(projectPath)
        await reconcilePending(projectPath, novelId)
        const record = (await readIndex(projectPath, novelId)).revisions.find(
          (revision) => revision.id === revisionId && revision.chapter === chapter,
        )
        if (!record) throw new Error('未找到该正文版本。')
        return {
          revision: toEntry(record),
          // 历史条目是一次 canonical 变更前的可恢复快照；新章节第一次 agent-write
          // 没有 before 正文时，才以本次写作形成的 after 正文作为首个版本。
          visibleText: await readBlob(projectPath, record.beforeHash ?? record.afterHash),
        }
      })
    },
  }
}

export const manuscriptRevisionStore = createManuscriptRevisionStore()
