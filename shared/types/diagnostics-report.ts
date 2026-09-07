/**
 * 「报告问题」诊断包契约（主进程组装 → 渲染端预览 → 用户确认后带去 GitHub Issue）。
 *
 * 为什么要有这份东西：打包版主进程此前没有任何日志文件，`console.warn` 全部丢掉；Windows 用户
 * 报 bug 我们只能拿截图猜。这份诊断包 + 主进程日志文件（electron/main/logging/main-log.ts）
 * 把「用户遇到问题 → 我们拿到可查的证据」这条链闭上。
 *
 * 隐私边界：logTail 在主进程侧已脱敏（家目录、API Key、Bearer 头），渲染端只做展示与拼 Issue 正文；
 * 用户在弹窗里看得到将要发出去的全部内容，确认后才打开 GitHub。
 */
export interface DiagnosticsReport {
  appVersion: string
  agentCoreVersion: string | null
  /** 'darwin' | 'win32' | 'linux' */
  platform: string
  arch: string
  /** 系统版本（Electron process.getSystemVersion()，如 "15.5" / "10.0.26100"）。 */
  osVersion: string
  electronVersion: string
  locale: string
  /** 主进程日志文件的绝对路径（给「打开日志文件夹」用，不进 Issue 正文）。 */
  logPath: string
  /** 主进程日志末尾（已脱敏），按行；没有日志时为空数组。 */
  logTail: string[]
  /** 生成时刻（ISO）。 */
  generatedAt: string
}
