/**
 * 进程健康事件的纯判定与格式化（#39），两进程共用：
 * 主进程按这里的规则决定「记不记、提不提示」，渲染端按这里的规则把记录渲染成人话。
 */
import type { ProcessGoneReason, ProcessHealthEvent } from '@shared/types/process-health'

/** 记录上限。取证只关心最近发生了什么，留太多既没用又会让文件无限长。 */
export const MAX_RETAINED_EVENTS = 50

/**
 * `clean-exit` 是正常退出——关窗口、正常 reload 都会触发。记录它等于往取证里灌噪声，
 * 提示它等于每次关窗都弹一个「崩溃了」的框。
 */
export function isAbnormalReason(reason: ProcessGoneReason): boolean {
  return reason !== 'clean-exit'
}

/**
 * 该不该打断作者。
 *
 * 只有渲染进程真的没了、UI 已经不可用时才提示——这时作者面对的是白屏，不提示他就只能干等。
 * `launch-failed` / `integrity-failure` 同样致命（窗口起不来），一并提示。
 * `memory-eviction` 是系统主动回收后台页面、Electron 会自行恢复，不打扰。
 */
export function shouldPromptAuthor(reason: ProcessGoneReason): boolean {
  return (
    reason === 'crashed' ||
    reason === 'oom' ||
    reason === 'abnormal-exit' ||
    reason === 'killed' ||
    reason === 'launch-failed' ||
    reason === 'integrity-failure'
  )
}

/** 给作者看的一句话——不出现 reason 原文这类技术黑话。 */
export function describeReasonForAuthor(reason: ProcessGoneReason): string {
  if (reason === 'oom') return '界面因为内存不足被系统回收了。'
  if (reason === 'killed') return '界面进程被系统结束了。'
  if (reason === 'launch-failed') return '界面没能启动起来。'
  if (reason === 'integrity-failure') return '界面文件校验没通过。'
  return '界面进程意外退出了。'
}

/**
 * 诊断折叠里的一行摘要。
 *
 * 保留 reason / exitCode 原文——这一行的读者是「作者截图发给我们」之后的我们，
 * 可读性让位于可诊断性；真正给作者读的是 describeReasonForAuthor 那句。
 */
export function summarizeProcessHealthEvent(event: ProcessHealthEvent): string {
  const when = event.at.replace('T', ' ').replace(/\.\d+Z$/, '')
  if (event.kind === 'main-thread-blocked') {
    const duration = event.blockedMs === undefined ? '未恢复' : `${Math.round(event.blockedMs / 1000)}s`
    return `${when} 界面卡住（${duration}）`
  }
  if (event.kind === 'child-gone') {
    const who = event.processName ?? event.processType ?? '子进程'
    return `${when} ${who} 退出（${event.reason}, code ${event.exitCode}）`
  }
  return `${when} 界面进程退出（${event.reason}, code ${event.exitCode}）`
}

/** 最近的在前，超出上限的丢弃。 */
export function retainRecentEvents(
  existing: ProcessHealthEvent[],
  incoming: ProcessHealthEvent,
  max: number = MAX_RETAINED_EVENTS,
): ProcessHealthEvent[] {
  return [incoming, ...existing].slice(0, max)
}

/** 读回落盘记录；文件缺失或损坏都当作「没有记录」——取证本身不该成为启动失败的原因。 */
export function parseProcessHealthEvents(raw: string): ProcessHealthEvent[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is ProcessHealthEvent =>
        typeof item === 'object' && item !== null && 'kind' in item && 'at' in item,
    )
  } catch {
    return []
  }
}
