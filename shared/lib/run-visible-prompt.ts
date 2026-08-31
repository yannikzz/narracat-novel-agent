import type { AgentEvent } from '@shared/types/agent'

type RunStartedEvent = Extract<AgentEvent, { type: 'run.started' }>

/**
 * run.started 在对话里显示成什么文案——渲染端实时气泡与主进程 durable 落盘**共用这一份**。
 *
 * 这两侧曾各有一份同源副本，改一份漏一份的后果是：当下看着正常，重开 App 翻历史却是空气泡。
 * 放进 shared 是为了让它只有一处可改（ADR-0036：shared 是唯一允许双侧 import 的层）。
 *
 * 兜底的两类情况，共同点都是 prompt 不是给人看的话：
 * - review / rewrite：prompt 是章号参数
 * - write-next / recover-write：prompt 是「作者补充意图」，作者没补充时就是空串
 *   （产品默认文案不当作者的话往下发，见渲染端 resolveAgentRunPrompt）
 */
export function resolveRunVisiblePrompt(event: RunStartedEvent): string {
  // 显式干净文案优先：空页/预设动作把定位元信息塞进 prompt 给 Agent，气泡只显示 displayPrompt。
  const displayPrompt = event.displayPrompt?.trim()
  if (displayPrompt) return displayPrompt

  if ((event.command === 'review' || event.command === 'rewrite') && event.selectedChapter) {
    if (event.prompt.trim() === String(event.selectedChapter)) {
      return `${event.command === 'review' ? '审修' : '重写'}第 ${event.selectedChapter} 章`
    }
  }

  if ((event.command === 'write-next' || event.command === 'recover-write') && !event.prompt.trim()) {
    const chapterSuffix = event.selectedChapter ? `第 ${event.selectedChapter} 章` : '本章'
    return event.command === 'recover-write' ? `继续完成${chapterSuffix}` : `写${chapterSuffix}`
  }

  return event.prompt
}
