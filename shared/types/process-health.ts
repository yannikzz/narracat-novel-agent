/**
 * 进程健康事件契约（#39 取证半边）。
 *
 * 渲染进程崩溃、GPU / utility 子进程崩溃、主线程挂死——这三类事件此前在 App 里**完全静默**：
 * 作者只看到白屏或点不动，我们拿不到一行日志，只能靠外部工具猜。这个缺口有前科：#1
 * （Windows 打包版渲染原生 `<details>` 挂死主线程）是贡献者靠 9 轮打包二分才定位的，
 * 有 `unresponsive` 事件的话第一轮就能看出是主线程同步阻塞而非应用逻辑。
 */

/** 事件种类。三类分别对应 Electron 的 render-process-gone / child-process-gone / unresponsive。 */
export type ProcessHealthEventKind = 'renderer-gone' | 'child-gone' | 'main-thread-blocked'

/**
 * 进程消失的原因，取自 Electron 的 `RenderProcessGoneDetails['reason']` 与 `Details['reason']`。
 *
 * 注意 `clean-exit` 是正常退出（关窗口时也会触发），**不记录、不提示**——否则每次正常关窗
 * 都会往取证记录里塞噪声，还会弹出莫名其妙的崩溃提示框。
 */
export type ProcessGoneReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | 'memory-eviction'

export interface ProcessHealthEvent {
  kind: ProcessHealthEventKind
  /** ISO 时间戳。作者截图求助时，这一条决定了「什么时候发生的」。 */
  at: string
  /** 进程消失类事件的原因；主线程阻塞事件没有。 */
  reason?: ProcessGoneReason
  exitCode?: number
  /** child-gone 专有：'GPU' | 'Utility' | … 。NovelMemory 跑在 utilityProcess 上，挂了会落在这里。 */
  processType?: string
  /** child-gone 专有：进程名（如 `Audio Service`）。 */
  processName?: string
  /**
   * main-thread-blocked 专有：阻塞时长（毫秒）。
   * 只有配对到 `responsive` 才有值；一直没恢复就保持 undefined（那通常意味着作者已经强退了）。
   */
  blockedMs?: number
  /** 客户端版本——跨版本对比时用得上，作者未必说得清当时用的哪版。 */
  appVersion?: string
}

export interface ProcessHealthReport {
  /** 最近的事件在前。上限见主进程侧 MAX_RETAINED_EVENTS。 */
  events: ProcessHealthEvent[]
  /** 记录文件路径——诊断信息里展示出来，作者可以直接找到并回传。 */
  logPath: string
}
