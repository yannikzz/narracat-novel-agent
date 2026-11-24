// electron/main/novel/progress-reconcile.ts
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getMemoryHostFor, type EngineCallPaths } from '../memory/index.ts'
import type { MemoryHost } from '../memory/memory-host.ts'
import { chapterReceiptsDir, narracatStatePath } from './novel-layout.ts'
import { parseYamlRecord, readRecord } from './yaml.ts'

/**
 * 打开作品时对齐完成进度：章确实写完过（引擎认的四样证据齐全）却没记进完成进度时补回，
 * 否则「下一步」会指回已写好的章。判定与写入归引擎 novel_reconcile_progress（只加不删、
 * 不碰正文与 memory.db），App 经 memory host 确定性直调，零 LLM，同 planned-state-edit.ts。
 *
 * 引擎进程按项目惰性启动，绝大多数作品进度本来就对：先在 App 侧看一眼有没有「有收尾回执却不在
 * 完成进度里」的章，没有就不叫醒引擎。这只是省一次进程启动的前置筛，补不补仍以引擎判定为准。
 */

const RECONCILE_PROGRESS_TOOL = 'novel_reconcile_progress'
const RECEIPT_FILE_PATTERN = /^ch-(\d+)\.json$/

/** 有收尾回执却不在完成进度里的章号；state.yaml 读不出时返回空（引擎同样会拒绝，不必调用）。 */
export async function findUnrecordedReceiptChapters(projectPath: string): Promise<number[]> {
  let completed: Set<number>
  try {
    const state = parseYamlRecord(await readFile(join(projectPath, narracatStatePath()), 'utf-8'), 'state.yaml')
    const raw = readRecord(state, 'progress').completed_chapters
    completed = new Set(Array.isArray(raw) ? raw.filter((item): item is number => Number.isInteger(item)) : [])
  } catch {
    return []
  }

  let files: string[]
  try {
    files = await readdir(join(projectPath, chapterReceiptsDir()))
  } catch {
    return []
  }
  return files
    .map((file) => RECEIPT_FILE_PATTERN.exec(file)?.[1])
    .filter((digits): digits is string => digits !== undefined)
    .map(Number)
    .filter((chapter) => !completed.has(chapter))
    .sort((a, b) => a - b)
}

export interface ReconcileProgressOnOpenDeps {
  paths: EngineCallPaths
  /** 本作品有 Agent 任务在跑：让给它——写章会自己收尾进度，并发读改写 state.yaml 会互相覆盖。 */
  isProjectBusy: (projectPath: string) => Promise<boolean>
  /** 与备份等项目级写操作互斥（runProjectMutation）。 */
  withProjectLock: <T>(projectPath: string, operation: () => Promise<T>) => Promise<T>
  /** 可注入 host（测试用），缺省取进程级单例。 */
  host?: MemoryHost
}

/** 打开作品时对账一次；任何失败只记日志不抛——对不上进度不能挡住作者打开作品。 */
export async function reconcileProgressOnOpen(projectPath: string, deps: ReconcileProgressOnOpenDeps): Promise<void> {
  try {
    if ((await findUnrecordedReceiptChapters(projectPath)).length === 0) return
    if (await deps.isProjectBusy(projectPath)) return
    const raw = await deps.withProjectLock(projectPath, () =>
      (deps.host ?? getMemoryHostFor(deps.paths)).callTool(projectPath, RECONCILE_PROGRESS_TOOL, {}),
    )
    const result = JSON.parse(raw.text ?? '') as { ok?: unknown }
    if (raw.isError === true || result?.ok !== true) console.error('完成进度对账被引擎拒绝', raw.text)
  } catch (error) {
    console.error('完成进度对账失败', error)
  }
}
