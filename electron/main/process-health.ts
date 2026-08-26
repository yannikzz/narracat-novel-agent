/**
 * 进程健康取证（#39）：渲染进程崩溃 / 子进程崩溃 / 主线程挂死留痕。
 *
 * 在此之前这三类事件在 App 里完全静默——作者看到白屏或点不动，我们拿不到任何信息。
 * 这里做三件事，且只做这三件：
 *   1. 留痕：事件落进 userData 的 JSON，重启后仍在（崩溃诊断最需要的恰恰是「上次崩的那条」）
 *   2. 给作者一句能看懂的话 + 一个「重新加载」的出口，而不是白屏干等
 *   3. 把记录暴露到设置-关于的诊断信息里，作者截图即可求助
 *
 * 刻意不做的事：不自动重载（崩溃循环时会变成无限重启，且掩盖问题）、不上报任何服务端、
 * 不因为 `unresponsive` 弹框（主线程阻塞几秒就会触发，写作中偶发一次不值得打断作者）。
 */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import type {
  ProcessGoneReason,
  ProcessHealthEvent,
  ProcessHealthReport,
} from '@shared/types/process-health'
import {
  describeReasonForAuthor,
  isAbnormalReason,
  parseProcessHealthEvents,
  retainRecentEvents,
  shouldPromptAuthor,
} from '@shared/lib/process-health'
import { atomicWriteFile } from './atomic-write.ts'

/** 同一窗口两次崩溃提示的最小间隔：崩溃循环时不至于把作者按在弹框里。 */
export const CRASH_PROMPT_COOLDOWN_MS = 60_000

export const PROCESS_HEALTH_LOG_FILENAME = 'process-health.json'

export interface ProcessHealthStoreDeps {
  userDataPath: string
  appVersion: string
  now?: () => Date
  readFileImpl?: typeof readFile
  writeFileImpl?: (path: string, content: string) => Promise<void>
}

export interface ProcessHealthStore {
  record(event: Omit<ProcessHealthEvent, 'at' | 'appVersion'>): Promise<void>
  read(): Promise<ProcessHealthReport>
  logPath: string
}

export function createProcessHealthStore({
  userDataPath,
  appVersion,
  now = () => new Date(),
  readFileImpl = readFile,
  writeFileImpl = (path, content) => atomicWriteFile(path, content),
}: ProcessHealthStoreDeps): ProcessHealthStore {
  const logPath = join(userDataPath, PROCESS_HEALTH_LOG_FILENAME)

  async function readEvents(): Promise<ProcessHealthEvent[]> {
    try {
      return parseProcessHealthEvents(await readFileImpl(logPath, 'utf-8'))
    } catch {
      return []
    }
  }

  return {
    logPath,
    async read() {
      return { events: await readEvents(), logPath }
    },
    async record(event) {
      const entry: ProcessHealthEvent = { ...event, at: now().toISOString(), appVersion }
      const next = retainRecentEvents(await readEvents(), entry)
      try {
        await writeFileImpl(logPath, `${JSON.stringify(next, null, 2)}\n`)
      } catch (error) {
        // 取证写不进去不能反过来拖垮 App——它本来就是在「已经出事了」的路径上运行的。
        console.error('[process-health] 事件落盘失败:', error)
      }
    },
  }
}

export interface AttachProcessHealthWatchersDeps {
  store: ProcessHealthStore
  /** 崩溃后询问作者是否重新加载；返回 true 表示作者选择重载。 */
  promptReload: (message: string, detail: string) => Promise<boolean>
  now?: () => number
}

/**
 * 给一个窗口挂上三类监听。返回解绑函数（测试与多窗口场景用）。
 *
 * `app.on('child-process-gone')` 是进程级的，不属于任何窗口，由 attachAppProcessHealthWatcher
 * 单独挂一次——挂在窗口上会随窗口数量重复记录同一次崩溃。
 */
export function attachWindowProcessHealthWatchers(
  win: BrowserWindow,
  { store, promptReload, now = () => Date.now() }: AttachProcessHealthWatchersDeps,
): () => void {
  // null = 从未提示过。用 0 会让「首次崩溃」落进冷却窗口里被误抑制——真实环境的
  // Date.now() 数值巨大所以碰巧不触发，但那是靠运气，注入时钟的测试一下就撞出来了。
  let lastPromptAt: number | null = null
  let blockedSince: number | null = null

  const onRenderProcessGone = (_event: unknown, details: { reason: ProcessGoneReason; exitCode: number }) => {
    if (!isAbnormalReason(details.reason)) return
    void store.record({ kind: 'renderer-gone', reason: details.reason, exitCode: details.exitCode })
    if (!shouldPromptAuthor(details.reason)) return

    // 崩溃循环保护：reload 后立刻又崩时，不把作者按在连续弹框里。
    const at = now()
    if (lastPromptAt !== null && at - lastPromptAt < CRASH_PROMPT_COOLDOWN_MS) return
    lastPromptAt = at

    void promptReload(
      describeReasonForAuthor(details.reason),
      '已写入的小说内容都在磁盘上，不会因此丢失。可以重新加载界面继续；如果反复出现，请到「设置 - 关于 - 诊断信息」把记录发给我们。',
    ).then((shouldReload) => {
      if (shouldReload && !win.isDestroyed()) win.reload()
    })
  }

  const onUnresponsive = () => {
    blockedSince = now()
  }

  const onResponsive = () => {
    if (blockedSince === null) return
    void store.record({ kind: 'main-thread-blocked', blockedMs: now() - blockedSince })
    blockedSince = null
  }

  win.webContents.on('render-process-gone', onRenderProcessGone)
  win.on('unresponsive', onUnresponsive)
  win.on('responsive', onResponsive)

  return () => {
    win.webContents.off('render-process-gone', onRenderProcessGone)
    win.off('unresponsive', onUnresponsive)
    win.off('responsive', onResponsive)
  }
}

export interface AppProcessHealthWatcherDeps {
  store: ProcessHealthStore
  onChildGone: (listener: (event: unknown, details: ChildProcessGoneDetails) => void) => void
}

export interface ChildProcessGoneDetails {
  type: string
  reason: ProcessGoneReason
  exitCode: number
  serviceName?: string
  name?: string
}

/**
 * 进程级子进程崩溃留痕：覆盖 GPU 与 utility 进程。
 *
 * NovelMemory 跑在 utilityProcess 上，它挂掉目前只会让下一次工具调用报错，进程本身怎么没的
 * 没有任何记录——而记忆库是产品的命根，这条留痕的价值高于 GPU 那条。
 */
export function attachAppProcessHealthWatcher({ store, onChildGone }: AppProcessHealthWatcherDeps): void {
  onChildGone((_event, details) => {
    if (!isAbnormalReason(details.reason)) return
    void store.record({
      kind: 'child-gone',
      reason: details.reason,
      exitCode: details.exitCode,
      processType: details.type,
      processName: details.name ?? details.serviceName,
    })
  })
}
