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
import type { ManuscriptRevisionEntry } from '@shared/types/manuscript-revision'
import { adoptPolishedChapter } from './polish-adopt.ts'
import type { PolishRunManager } from './polish-runner.ts'
import type { OpenMemoryDb } from '../novel/memory-db.ts'
import { readWrittenChapterSet } from '../novel/novel-project.ts'
import { readPolishSettings, recordStandingPolishOutcome } from '../novel/polish-settings.ts'

export interface StandingPolishDeps {
  /** 单槽、无流式的润色执行（PolishRunManager.polishChapterOnce） */
  polishOnce: PolishRunManager['polishChapterOnce']
  resolveChapter?: (projectPath: string) => Promise<number | null>
  openMemoryDb?: OpenMemoryDb
  now?: () => string
  /**
   * 把采用那一步包进项目写入闸（与 `novel:save-chapter-manuscript` 同一道），
   * 避免备份插在正文、版本记录与分家标识之间拿到内部不一致的归档。
   * 只包采用——模型调用要跑十几秒，不能占着项目锁。
   */
  withProjectLock?: <T>(projectPath: string, operation: () => Promise<T>) => Promise<T>
  /**
   * 本次写作 run 期间，这一章有没有真的产出过正文。
   *
   * 写作命令有「先不写」这条出口、run 照样正常结束——不判这个就会把上一章重润一遍。
   * 判据用「本次 run 期间登记过版本记录」而不是文件 mtime：草稿区正文是 rename 搬进正式路径的，
   * mtime 可能停留在更早（恢复写作尤其明显，草稿是上一次中断时写的），按 mtime 判会漏。
   */
  hasFreshManuscript?: (projectPath: string, chapter: number) => Promise<boolean>
}

/**
 * 「本次写作 run 期间，这一章登记过 agent-write 版本记录」= 这一章真的由这次写作产出了正文。
 *
 * 三个条件缺一不可：①来源必须是 `agent-write`——只判时间的话，作者在「先不写」期间手改保存
 * 一次，那条 `author-save` 也会把常驻误触发起来；②不早于 run 起点——否则重润上一章；
 * ③不晚于 run 终点——这个检查是异步旁路，只判起点的话，下一轮很快写出的正文会被这一轮
 * 迟到的检查错认成自己的。时间解析不出来按「不新鲜」处理（fail-safe：不确定就当没写）。
 */
export function hasAgentWriteWithinRun(
  revisions: ManuscriptRevisionEntry[],
  run: { startedAt: string; finishedAt: string },
): boolean {
  const start = Date.parse(run.startedAt)
  const end = Date.parse(run.finishedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false
  return revisions.some((revision) => {
    if (revision.source !== 'agent-write') return false
    const at = Date.parse(revision.createdAt)
    return Number.isFinite(at) && at >= start && at <= end
  })
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

  // 「先不写」也会让 run 正常结束。没有新落盘的正文就什么都不做——重润上一章既烧钱，
  // 又会把作者上次已经挑定的那一版悄悄换掉。
  if (deps.hasFreshManuscript && !(await deps.hasFreshManuscript(projectPath, chapter))) {
    return { status: 'off' }
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

  const withLock = deps.withProjectLock ?? (async (_path, operation) => operation())
  const adopted = await withLock(projectPath, () =>
    adoptPolishedChapter(
      {
        projectPath,
        chapter,
        slotId: settings.standingSlotId!,
        polishedText: result.text,
        // 基线必须是「送去润色的那一份」，不能在模型返回后重读磁盘——重读等于把作者
        // 生成期间的手改当成基线，乐观锁形同虚设，A′ 会直接盖掉 B。
        expectedVisibleText: result.originalText,
      },
      { openMemoryDb: deps.openMemoryDb },
    ),
  )
  if (!adopted.ok) return skip(adopted.message)

  await recordStandingPolishOutcome(projectPath, chapter, { status: 'applied', at: now() }).catch((error) =>
    console.error('[polish] 记录采用结果失败', error),
  )
  return { status: 'applied', chapter }
}
