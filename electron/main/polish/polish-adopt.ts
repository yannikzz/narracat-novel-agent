/**
 * 采用某一版润色（ADR-0041 §7）。
 *
 * 写入完全复用正文直写管线（定位 → 乐观锁 → 元数据以磁盘版拼回 → 版本捕获 → 原子落盘），
 * 只换掉两处接缝：判据用润色护栏，impact 处置按章龄分流。
 *
 * 三分支：
 * | 情形 | 处置 |
 * |---|---|
 * | 无漂移（绝大多数） | 直接采用，记忆不动，不打红点 |
 * | 漂移 + 最新完成章 | 采用 + 打「记忆待同步」标记 → 走 /narracat:sync-chapter-memory |
 * | 漂移 + 旧章 | 需作者先确认，采用后登记「正文与记忆分家」——sync 不收旧章，rewrite 会抹掉
 *   作者刚润出的版本，确实没有出口，所以那是个纯陈述标识，不配任何按钮 |
 */
import { detectPolishDrift, describePolishDrift } from '@shared/lib/prose-polish-drift'
import type { PolishAdoptOutcome, PolishAdoptRequest } from '@shared/types/prose-polish'
import { isPolishSlotId } from '@shared/types/prose-polish'
import type { OpenMemoryDb } from '../novel/memory-db.ts'
import { collectManuscriptEntityNames } from '../novel/manuscript-entities.ts'
import { submitManuscriptEdit, type ManuscriptSaveResult } from '../novel/manuscript-edit.ts'
import { markPendingMemorySync } from '../novel/pending-memory-sync.ts'
import { markChapterDiverged } from '../novel/polish-settings.ts'
import { readWrittenChapterSet } from '../novel/novel-project.ts'
import type { ManuscriptTriage } from '../novel/manuscript-triage.ts'

export type PolishAdoptResult =
  | { ok: true; outcome: PolishAdoptOutcome }
  | { ok: false; conflict?: boolean; needsDivergenceAck?: boolean; message: string }

export function parsePolishAdoptInput(input: unknown): PolishAdoptRequest {
  const raw = (input ?? {}) as Record<string, unknown>
  if (typeof raw.projectPath !== 'string' || !raw.projectPath.trim()) throw new Error('缺少项目路径。')
  if (typeof raw.chapter !== 'number' || !Number.isInteger(raw.chapter) || raw.chapter < 1) {
    throw new Error('章号参数非法。')
  }
  if (!isPolishSlotId(raw.slotId)) throw new Error('润色槽位非法。')
  if (typeof raw.polishedText !== 'string' || !raw.polishedText.trim()) throw new Error('润色后的正文为空。')
  if (typeof raw.expectedVisibleText !== 'string') throw new Error('原正文参数非法。')

  return {
    projectPath: raw.projectPath,
    chapter: raw.chapter,
    slotId: raw.slotId,
    polishedText: raw.polishedText,
    expectedVisibleText: raw.expectedVisibleText,
    divergenceAcknowledged: raw.divergenceAcknowledged === true,
  }
}

/**
 * 判断这一章是不是「目前完成写作的最新一章」——`/narracat:sync-chapter-memory` v1 只收这一章。
 *
 * 读不到进度时按「是最新章」处理：那条路会打红点、把作者送到同步命令面前，而命令自己会再核一遍
 * 章龄并如实告知。反过来误判成旧章，就会平白告诉作者「记忆永远不会同步了」——那是不可撤销的
 * 错误信息，代价高得多。
 */
async function isLatestCompletedChapter(projectPath: string, chapter: number): Promise<boolean> {
  const written = await readWrittenChapterSet(projectPath).catch(() => new Set<number>())
  if (written.size === 0) return true
  return chapter >= Math.max(...written)
}

export async function adoptPolishedChapter(
  request: PolishAdoptRequest,
  { openMemoryDb }: { openMemoryDb?: OpenMemoryDb } = {},
): Promise<PolishAdoptResult> {
  const anchorNames = await collectManuscriptEntityNames({ projectPath: request.projectPath, openMemoryDb }).catch(
    () => [] as string[],
  )
  const drift = detectPolishDrift({
    original: request.expectedVisibleText,
    polished: request.polishedText,
    anchorNames,
  })

  const latest = drift.drifted ? await isLatestCompletedChapter(request.projectPath, request.chapter) : true

  // 旧章的漂移版会让正文与记忆永久分家，作者必须先看到这句话再决定。
  if (drift.drifted && !latest && !request.divergenceAcknowledged) {
    return {
      ok: false,
      needsDivergenceAck: true,
      message: '这一版改动了情节。旧章节的改动不会进入记忆，后续创作仍按原来的情节走。',
    }
  }

  const triage: ManuscriptTriage = {
    tier: drift.drifted ? 'impact' : 'silent',
    reasons: drift.drifted ? [`润色改动了事实：${describePolishDrift(drift)}`] : [],
    stats: { addedChars: 0, removedChars: 0 },
    hunks: [],
  }

  const saved: ManuscriptSaveResult = await submitManuscriptEdit(
    {
      projectPath: request.projectPath,
      chapter: request.chapter,
      expectedVisibleText: request.expectedVisibleText,
      newVisibleText: request.polishedText,
      source: 'llm-polish',
    },
    {
      openMemoryDb,
      // 护栏已在上面按润色判据算过，这里原样返回：整章重述过不了 ADR-0031 的三信号，
      // 用默认判据会每章一个假红点。
      classify: () => triage,
      onImpact: async ({ projectPath, chapter }) => {
        if (latest) {
          await markPendingMemorySync(projectPath, chapter, triage.reasons)
          return
        }
        await markChapterDiverged(projectPath, chapter)
      },
    },
  )

  if (!saved.ok) return saved

  if (!drift.drifted) return { ok: true, outcome: { kind: 'clean' } }
  return {
    ok: true,
    outcome: latest
      ? { kind: 'pending-sync', chapter: request.chapter }
      : { kind: 'diverged', chapter: request.chapter },
  }
}
