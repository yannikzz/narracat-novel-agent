/**
 * 「报告问题」诊断包组装（主进程侧）：版本 / 系统信息 + 主进程日志尾（已脱敏）。
 * 纯函数层在 shared/lib/diagnostics-report；这里只负责把 Electron 与文件系统的事实喂进去。
 */
import { homedir } from 'node:os'
import { sanitizeLogText, takeLogTail } from '@shared/lib/diagnostics-report'
import type { DiagnosticsReport } from '@shared/types/diagnostics-report'
import type { MainLog } from './logging/main-log.ts'

/** 日志尾读多少：200 行足够覆盖一次完整 run 的 warn/error，再多用户也看不过来。 */
const LOG_TAIL_LINES = 200
const LOG_TAIL_READ_BYTES = 256 * 1024

export interface BuildDiagnosticsReportDeps {
  appVersion: string
  agentCoreVersion: string | null
  platform: string
  arch: string
  osVersion: string
  electronVersion: string
  locale: string
  log: MainLog | undefined
  homeDir?: string
  now?: () => Date
}

export function buildDiagnosticsReport(deps: BuildDiagnosticsReportDeps): DiagnosticsReport {
  const raw = deps.log?.readTail(LOG_TAIL_READ_BYTES) ?? ''
  const sanitized = sanitizeLogText(raw, { homeDir: deps.homeDir ?? homedir() })
  return {
    appVersion: deps.appVersion,
    agentCoreVersion: deps.agentCoreVersion,
    platform: deps.platform,
    arch: deps.arch,
    osVersion: deps.osVersion,
    electronVersion: deps.electronVersion,
    locale: deps.locale,
    logPath: deps.log?.path ?? '',
    logTail: takeLogTail(sanitized, LOG_TAIL_LINES),
    generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
  }
}
