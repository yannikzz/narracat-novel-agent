/**
 * 常驻润色（ADR-0041 §8）：写完一章之后，App 层自动追加的那一步。
 *
 * 位置是刻意的——它跑在 `/narracat:write` **整条命令跑完之后**，所以记忆入库的永远是未润色的
 * 原始版，润色改坏文字的爆炸半径被封死在正文文字层。引擎一个字都不用改。
 *
 * 只有两种结局：**润好了覆盖**，或**原稿原封不动**。任何异常（漂移、报错、配方为空、模型没配）
 * 一律回到后者——常驻模式没有观众，没人看着的时候默认保守。跳过一定留痕，静默跳过会变成
 * 「怎么好几章没润色」的哑谜。
 */
import { describePolishDrift } from '@shared/lib/prose-polish-drift'
import { adoptPolishedChapter } from './polish-adopt.ts'
import type { PolishRunManager } from './polish-runner.ts'
import type { OpenMemoryDb } from '../novel/memory-db.ts'
import { readVisibleManuscriptText } from '../novel/manuscript-file.ts'
import { readWrittenChapterSet } from '../novel/novel-project.ts'
import { readPolishSettings, recordStandingPolishOutcome } from '../novel/polish-settings.ts'

export interface StandingPolishDeps {
  /** 单槽、无流式的润色执行（PolishRunManager.polishChapterOnce） */
  polishOnce: PolishRunManager['polishChapterOnce']
  readOriginalText?: (projectPath: string, chapter: number) => Promise<string | null>
  resolveChapter?: (projectPath: string) => Promise<number | null>
  openMemoryDb?: OpenMemoryDb
  now?: () => string
}

export type StandingPolishResult =
  | { status: 'off' }
  | { status: 'applied'; chapter: number }
  | { status: 'skipped'; chapter: number; note: string }

/** 刚写完的那一章 = 已完成集合里的最大章号（write-next 的 selectedChapter 可能为空，不能依赖）。 */
async function latestWrittenChapter(projectPath: string): Promise<number | null> {
  const written = await readWrittenChapterSet(projectPath).catch(() => new Set<number>())
  if (written.size === 0) return null
  return Math.max(...written)
}

export async function runStandingPolish(
  projectPath: string,
  deps: StandingPolishDeps,
): Promise<StandingPolishResult> {
  const settings = await readPolishSettings(projectPath)
  if (!settings.standingSlotId) return { status: 'off' }

  const resolveChapter = deps.resolveChapter ?? latestWrittenChapter
  const chapter = await resolveChapter(projectPath)
  if (chapter === null) return { status: 'off' }

  const now = deps.now ?? (() => new Date().toISOString())
  const skip = async (note: string): Promise<StandingPolishResult> => {
    await recordStandingPolishOutcome(projectPath, chapter, { status: 'skipped', at: now(), note }).catch(
      (error) => console.error('[polish] 记录跳过结果失败', error),
    )
    return { status: 'skipped', chapter, note }
  }

  let result: Awaited<ReturnType<PolishRunManager['polishChapterOnce']>>
  try {
    result = await deps.polishOnce({ projectPath, chapter, slotId: settings.standingSlotId })
  } catch (error) {
    return skip(error instanceof Error ? error.message : '润色没跑成')
  }

  if (result.drift.drifted) {
    // 常驻的前提是这套配方在试验阶段验证过；突发漂移即异常，默认保守。
    return skip(`这次的润色改动了情节（${describePolishDrift(result.drift)}），已保留原稿`)
  }

  const readOriginal = deps.readOriginalText ?? readVisibleManuscriptText
  const original = await readOriginal(projectPath, chapter)
  if (!original) return skip('没找到这一章的正文')

  const adopted = await adoptPolishedChapter(
    {
      projectPath,
      chapter,
      slotId: settings.standingSlotId,
      polishedText: result.text,
      expectedVisibleText: original,
    },
    { openMemoryDb: deps.openMemoryDb },
  )
  if (!adopted.ok) return skip(adopted.message)

  await recordStandingPolishOutcome(projectPath, chapter, { status: 'applied', at: now() }).catch((error) =>
    console.error('[polish] 记录采用结果失败', error),
  )
  return { status: 'applied', chapter }
}
