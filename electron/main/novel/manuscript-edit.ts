import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '../atomic-write.ts'
import { NARRACAT_DIR } from './novel-layout.ts'
import { collectManuscriptEntityNames } from './manuscript-entities.ts'
import { markPendingMemorySync } from './pending-memory-sync.ts'
import { triageManuscriptEdit, type ManuscriptTriage } from './manuscript-triage.ts'
import type { OpenMemoryDb } from './memory-db.ts'
import type {
  ManuscriptRevisionStore,
} from './manuscript-revisions.ts'
import { manuscriptRevisionStore } from './manuscript-revisions.ts'
import type {
  ManuscriptRevisionSource,
  RestoreManuscriptRevisionInput,
} from '@shared/types/manuscript-revision'
import {
  joinChapterMetadataComment,
  locateManuscriptFile,
  normalizeManuscriptText,
  splitChapterMetadataComment,
} from './manuscript-file.ts'

export {
  joinChapterMetadataComment,
  locateManuscriptFile,
  splitChapterMetadataComment,
} from './manuscript-file.ts'

/**
 * 正文直写管线（ADR-0031）：定位 → 读盘 → 乐观锁（可见文比对）→ 元数据以磁盘版拼回 →
 * 分诊 → 写盘 → 编辑留痕 / 待同步标记。保存永远先落盘：分诊只决定是否浮出第二档，
 * 不阻塞写入。渲染端永不经手 chapter_metadata 注释。
 */

export interface ManuscriptEditRequest {
  projectPath: string
  chapter: number
  /** 乐观锁：编辑器打开时的可见正文（已剥元数据注释）。 */
  expectedVisibleText: string
  newVisibleText: string
  /** 主进程内部来源；renderer 的保存 IPC 不接受该字段。 */
  source?: ManuscriptRevisionSource
}

export type ManuscriptSaveResult =
  | { ok: true; triage: { tier: 'silent' | 'impact'; reasons: string[] } }
  | { ok: false; conflict?: boolean; message: string }

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}参数非法。`)
  return value
}

export function parseManuscriptEditInput(input: unknown): ManuscriptEditRequest {
  const raw = (input ?? {}) as Record<string, unknown>
  const projectPath = asString(raw.projectPath, '项目路径')
  const chapter = raw.chapter
  if (typeof chapter !== 'number' || !Number.isInteger(chapter) || chapter < 1) throw new Error('章号参数非法。')
  const newVisibleText = asString(raw.newVisibleText, '正文内容')
  if (!newVisibleText.trim()) throw new Error('正文不能为空。')
  return {
    projectPath,
    chapter,
    expectedVisibleText: asString(raw.expectedVisibleText, '原正文'),
    newVisibleText,
  }
}

/** 纯函数：乐观锁比对 + 以磁盘版元数据注释拼出下一份完整文件内容。 */
export function applyManuscriptEdit({
  diskContent,
  expectedVisibleText,
  newVisibleText,
}: {
  diskContent: string
  expectedVisibleText: string
  newVisibleText: string
}):
  | { ok: true; nextContent: string; oldVisibleText: string }
  | { ok: false; conflict: true; message: string } {
  const { visibleText, metadataComments } = splitChapterMetadataComment(diskContent)
  if (normalizeManuscriptText(visibleText) !== normalizeManuscriptText(expectedVisibleText)) {
    return { ok: false, conflict: true, message: '正文已被修改（可能是 Agent 刚更新过），请刷新后再编辑。' }
  }
  return {
    ok: true,
    nextContent: joinChapterMetadataComment(newVisibleText, metadataComments),
    oldVisibleText: visibleText,
  }
}

/**
 * 分诊判据与 impact 处置的可替换接缝。
 *
 * 默认是 ADR-0031 的三信号 + 打「记忆待同步」标记。润色（ADR-0041）走同一条写入通道，但换掉
 * 这两处：判据改成「改了什么」的集合比对（三信号对整章重述必然误报），处置按章龄分流
 * （最新章打红点走同步；旧章记分家标识，因为 sync 不收旧章）。
 */
export interface ManuscriptEditSeams {
  openMemoryDb?: OpenMemoryDb
  revisionStore?: ManuscriptRevisionStore
  classify?: (input: { oldText: string; newText: string; entityNames: string[] }) => ManuscriptTriage
  onImpact?: (input: { projectPath: string; chapter: number; triage: ManuscriptTriage }) => Promise<void>
}

export async function submitManuscriptEdit(
  request: ManuscriptEditRequest,
  {
    openMemoryDb,
    revisionStore = manuscriptRevisionStore,
    classify = triageManuscriptEdit,
    onImpact,
  }: ManuscriptEditSeams = {},
): Promise<ManuscriptSaveResult> {
  const filePath = await locateManuscriptFile(request.projectPath, request.chapter)
  if (!filePath) return { ok: false, message: '未找到该章正文文件。' }

  let diskContent: string
  try {
    diskContent = await readFile(filePath, 'utf-8')
  } catch {
    return { ok: false, message: '读取正文失败。' }
  }

  const outcome = applyManuscriptEdit({
    diskContent,
    expectedVisibleText: request.expectedVisibleText,
    newVisibleText: request.newVisibleText,
  })
  if (!outcome.ok) return outcome

  const source = request.source ?? 'author-save'
  let revisionId: string
  try {
    revisionId = (
      await revisionStore.begin({
        projectPath: request.projectPath,
        chapter: request.chapter,
        source,
        beforeVisibleText: outcome.oldVisibleText,
      })
    ).revisionId
  } catch (error) {
    console.error('[manuscript-revisions] 保存前版本捕获失败', error)
    return { ok: false, message: '无法安全保存正文版本历史，正文尚未修改。' }
  }

  // 保存永远先落盘：分诊只决定是否浮出第二档，不阻塞写入。
  try {
    await atomicWriteFile(filePath, outcome.nextContent)
  } catch {
    await revisionStore.abort({ projectPath: request.projectPath, revisionId }).catch((error) => {
      console.error('[manuscript-revisions] 写入失败后清理待完成记录失败', error)
    })
    return { ok: false, message: '写入正文失败。' }
  }

  // 正文已原子落盘；若索引完成失败，begin 已保存的 pending capture 会在下次历史读取时 reconcile。
  try {
    await revisionStore.complete({
      projectPath: request.projectPath,
      revisionId,
      afterVisibleText: request.newVisibleText,
    })
  } catch (error) {
    console.error('[manuscript-revisions] 正文已保存，版本索引待后续恢复', error)
  }

  // 写盘成功后再计算实体与分诊；分诊失败绝不影响已完成的落盘。
  let triage: ManuscriptTriage = {
    tier: 'impact',
    reasons: ['改动未能自动核对，建议同步记忆'],
    stats: { addedChars: 0, removedChars: 0 },
    hunks: [],
  }
  try {
    let entityNames: string[] = []
    try {
      entityNames = await collectManuscriptEntityNames({ projectPath: request.projectPath, openMemoryDb })
    } catch {
      entityNames = []
    }
    triage = classify({
      oldText: outcome.oldVisibleText,
      newText: request.newVisibleText,
      entityNames,
    })
  } catch (error) {
    // 分诊失败绝不影响已完成的落盘；fail-safe 偏浮出（ADR-0031）
    console.error('[manuscript-edit] 分诊失败，按 impact 兜底', error)
  }
  if (source === 'revision-restore') {
    triage = {
      ...triage,
      tier: 'impact',
      reasons: [...new Set(['从正文版本历史恢复', ...triage.reasons])],
    }
  }

  // 旁路副作用：留痕（声音卡进料口，只写不读）与待同步标记，失败不阻塞保存。
  try {
    await mkdir(join(request.projectPath, NARRACAT_DIR), { recursive: true })
    const logEntry = {
      ts: new Date().toISOString(),
      chapter: request.chapter,
      tier: triage.tier,
      reasons: triage.reasons,
      stats: triage.stats,
      hunks: triage.hunks,
    }
    await appendFile(
      join(request.projectPath, NARRACAT_DIR, 'manuscript-edits.jsonl'),
      `${JSON.stringify(logEntry)}\n`,
      'utf-8',
    )
  } catch (error) {
    console.error('[manuscript-edit] 追加编辑留痕失败', error)
  }
  if (triage.tier === 'impact') {
    try {
      if (onImpact) {
        await onImpact({ projectPath: request.projectPath, chapter: request.chapter, triage })
      } else {
        await markPendingMemorySync(request.projectPath, request.chapter, triage.reasons)
      }
    } catch (error) {
      console.error('[manuscript-edit] impact 处置失败', error)
    }
  }

  return { ok: true, triage: { tier: triage.tier, reasons: triage.reasons } }
}

export async function restoreManuscriptRevision(
  request: RestoreManuscriptRevisionInput,
  {
    openMemoryDb,
    revisionStore = manuscriptRevisionStore,
  }: { openMemoryDb?: OpenMemoryDb; revisionStore?: ManuscriptRevisionStore } = {},
): Promise<ManuscriptSaveResult> {
  let content
  try {
    content = await revisionStore.readRevision(request)
  } catch (error) {
    console.error('[manuscript-revisions] 读取待恢复版本失败', error)
    return { ok: false, message: error instanceof Error ? error.message : '读取正文版本失败。' }
  }

  return submitManuscriptEdit(
    {
      projectPath: request.projectPath,
      chapter: request.chapter,
      expectedVisibleText: request.expectedVisibleText,
      newVisibleText: content.visibleText,
      source: 'revision-restore',
    },
    { openMemoryDb, revisionStore },
  )
}
