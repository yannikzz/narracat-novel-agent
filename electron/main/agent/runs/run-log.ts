/**
 * Agent run 生命周期日志（可归因底座）。
 *
 * ## 为什么
 *
 * issue #94：Windows 用户报「Agent 本次运行达到回合上限」，主进程日志里翻不到那次运行的**任何**
 * 痕迹——run-manager 整个生命周期此前只有一处 console.warn（且是关于答题的）。既不知道走了六条
 * run 路径里的哪条，也不知道回合预算是 12 还是 72，报告只能停在「无法归因」。
 *
 * 这里只做一件事：把每个 run 的**决策事实**写成一行可 grep 的文本。
 *
 * ## 记什么 / 不记什么
 *
 * 记：runId（关联开始与结束）、路径、命令、回合预算、运行时、是否挂引擎、是否续会话、章号。
 * 不记：prompt、正文、项目路径、密钥。作者写的字一个都不进日志——诊断价值为零，泄露成本极高；
 * 项目身份靠 thread 就够（ADR-0046 后 threadId 恒为 `novel:<id>` 或 `novel-path:<hash>`，不含路径）。
 *
 * 输出走 console.info/warn，由 logging/main-log.ts 接管落盘，此处不碰文件。
 */
import type { AgentEvent } from '@shared/types/agent'

/** 六条 run 路径（run-manager startRun 的分流出口），与 paths/ 目录一一对应。 */
export type AgentRunPathName =
  | 'write-next'
  | 'recover-write'
  | 'narracat-command'
  | 'resumed-command'
  | 'engine-context'
  | 'direct-chat'

export interface AgentRunStartLogInput {
  runId: string
  threadId: string
  command: string
  path: AgentRunPathName
  /** 本次 run 的回合预算。缺省即 adapter 默认值（direct-chat 走 12），日志记 `default` 以示区分。 */
  maxTurns?: number
  runtimeId: string
  loadNarraCatRuntime: boolean
  /**
   * 是否走「已有 project-command 会话续聊」路径。只覆盖 resumed-command 这一条：direct-chat 也可能
   * 悄悄 resume 上一段 direct 会话，但那个决定发生在路径模块内部、不出现在 RunPlan 里，这里不替它猜。
   */
  resumed: boolean
  selectedChapter?: number
}

export interface AgentRunEndLogInput {
  runId: string
  terminal: AgentEvent & { type: 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.interrupted' }
  elapsedMs: number
}

const LOG_PREFIX = '[agent-run]'
/** 错误文案只留首行且截断：日志是索引不是全文，长堆栈已由 console.error 自己那条覆盖。 */
const MAX_ERROR_CHARS = 200

function firstLine(text: string, limit = MAX_ERROR_CHARS): string {
  const line = text.split('\n', 1)[0]?.trim() ?? ''
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

/** 秒（一位小数）：run 常以分钟计，毫秒数在日志里读起来更费劲。 */
function formatElapsed(elapsedMs: number): string {
  return `${(Math.max(0, elapsedMs) / 1000).toFixed(1)}s`
}

export function formatAgentRunStartLog(input: AgentRunStartLogInput): string {
  const fields = [
    `runId=${input.runId}`,
    `path=${input.path}`,
    `command=${input.command}`,
    `maxTurns=${input.maxTurns ?? 'default'}`,
    `runtime=${input.runtimeId}`,
    `engine=${input.loadNarraCatRuntime ? 'on' : 'off'}`,
    `resume=${input.resumed ? 'yes' : 'no'}`,
    `thread=${input.threadId}`,
  ]
  if (input.selectedChapter !== undefined) fields.push(`chapter=${input.selectedChapter}`)
  return `${LOG_PREFIX} 开始 ${fields.join(' ')}`
}

export function formatAgentRunEndLog(input: AgentRunEndLogInput): string {
  const { terminal } = input
  const fields = [`runId=${input.runId}`, `终态=${terminal.type.replace('run.', '')}`, `耗时=${formatElapsed(input.elapsedMs)}`]
  if ('reason' in terminal && terminal.reason) fields.push(`reason=${terminal.reason}`)
  if ('error' in terminal && terminal.error) fields.push(`error=${firstLine(terminal.error)}`)
  return `${LOG_PREFIX} 结束 ${fields.join(' ')}`
}

/**
 * run 开始了却没产生任何终态。本身是异常（正常路径必然落到四种终态之一），单独成行是为了让
 * 「点了没反应」在日志里看得见——否则只剩一条孤零零的开始行，与 run 卡住无法区分。
 */
export function formatAgentRunNoTerminalLog(runId: string, elapsedMs: number): string {
  return `${LOG_PREFIX} 结束 runId=${runId} 终态=none 耗时=${formatElapsed(elapsedMs)}`
}

/**
 * 主会话触顶不在这里记：开始行已有 `maxTurns=<预算>`，结束行会带 `reason=max-turns`，两行合起来
 * 就是完整现场。子 agent 触顶另说——它不让主 run 失败、结束行看不见，由 pi-subagent 就地记 warn。
 */
