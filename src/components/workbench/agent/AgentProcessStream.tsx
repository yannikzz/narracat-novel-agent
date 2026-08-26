import { AgentProcessRow } from './AgentProcessRow'
import { getReasoningTitle } from './AgentPartView'
import { getToolPhrase } from './tool-phrase'
import { cn } from '@/lib/cn'
import type { AgentMessagePart, AgentPartStatus } from '@shared/types/agent'

export type AgentProcessPart = Extract<AgentMessagePart, { type: 'reasoning' | 'tool-call' | 'data' }>

interface ProcessSummary {
  title: string
  status: AgentPartStatus
}

export function isAgentProcessPart(part: AgentMessagePart): part is AgentProcessPart {
  return part.type === 'reasoning' || part.type === 'tool-call' || part.type === 'data'
}

export function AgentProcessStream({
  parts,
  defaultOpen = false,
  collapseKey,
}: {
  parts: AgentProcessPart[]
  defaultOpen?: boolean
  collapseKey?: string
}) {
  const summary = summarizeProcessStream(parts)

  return (
    <div
      data-agent-process-stream="true"
      aria-live={summary.status === 'running' ? 'polite' : undefined}
      className="min-w-0 max-w-full py-1 text-xs"
    >
      <AgentProcessRow
        title={summary.title}
        status={summary.status}
        detail={<ProcessDetail parts={parts} />}
        defaultOpen={defaultOpen}
        collapseKey={collapseKey}
      />
    </div>
  )
}

function summarizeProcessStream(parts: AgentProcessPart[]): ProcessSummary {
  const completedCount = countCompletedParts(parts)
  const runningPart = findLastPart(parts, (part) => part.status === 'running')
  if (runningPart) {
    return {
      title: `执行过程：${getRunningSummary(runningPart)} · 已完成 ${completedCount} 项`,
      status: 'running',
    }
  }

  // 工具级失败多数能自愈（换工具/重试后继续），所以不把整组执行过程标红——红色保留给 run 级
  // 终态失败（由独立的 error part 渲染）。但计次要如实说「失败」：原措辞「自动调整 N 次」把
  // 报错读成了 agent 的主动优化，作者据此以为一切正常，实际那 N 次可能正是成稿缺料的原因（#37）。
  const failedCount = parts.filter((part) => part.status === 'failed').length
  return {
    title:
      failedCount > 0
        ? `执行过程已完成 · ${completedCount} 项（${failedCount} 次失败）`
        : `执行过程已完成 · ${completedCount} 项`,
    status: 'complete',
  }
}

function ProcessDetail({ parts }: { parts: AgentProcessPart[] }) {
  return (
    <ol className="space-y-1">
      {parts.map((part) => {
        const failed = part.status === 'failed'
        const detail = getFailureDetail(part)

        return (
          <li key={part.id} className="min-w-0">
            <div className="flex min-w-0 items-start gap-2">
              <span
                className={cn(
                  'mt-0.5 shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] leading-none',
                  failed ? 'bg-warning/10 text-warning' : 'bg-active text-hint-foreground'
                )}
              >
                {getStatusLabel(part.status)}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{getProcessTitle(part)}</span>
            </div>
            {detail && (
              <div className="mt-1 ml-10 whitespace-pre-wrap break-words text-muted-foreground/80 [overflow-wrap:anywhere]">
                {detail}
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function findLastPart<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item !== undefined && predicate(item)) return item
  }
  return undefined
}

function countCompletedParts(parts: AgentProcessPart[]): number {
  return parts.filter((part) => part.status === 'complete').length
}

function getRunningSummary(part: AgentProcessPart): string {
  if (part.type === 'reasoning') return '正在整理思路...'
  if (part.type === 'tool-call') return getToolPhrase(part.toolName, part.input).loadingLabel
  return `正在${part.title}...`
}

function getFailureDetail(part: AgentProcessPart): string | undefined {
  if (part.type === 'tool-call' && part.status === 'failed') return compactProcessText(part.error ?? '')
  return undefined
}

function getProcessTitle(part: AgentProcessPart): string {
  if (part.type === 'reasoning') return getReasoningTitle(part.status)
  if (part.type === 'tool-call') {
    const phrase = getToolPhrase(part.toolName, part.input)
    return part.status === 'running' ? phrase.loadingLabel : phrase.label
  }
  return part.title
}

function getStatusLabel(status: AgentPartStatus): string {
  if (status === 'running') return '进行中'
  // 报错就说失败。AgentPartStatus 里没有「主动跳过」这一档——agent 判断无需执行的工具压根不会
  // 产生事件，所以 failed 唯一的含义就是失败，标成「已跳过」是把失败说成主动省略（#37 刀②）。
  // 中性色（warning，非 destructive）已足够表达「可自愈、不必惊慌」，不需要靠措辞去柔化。
  if (status === 'failed') return '失败'
  return '完成'
}

function compactProcessText(text: string): string {
  return text.replace(/(^|[\s("'`=])\/[^\s"'`<>]+/g, (match, prefix: string) => {
    const rawPath = match.slice(prefix.length)
    const trailing = rawPath.match(/[),.;:]+$/)?.[0] ?? ''
    const path = trailing ? rawPath.slice(0, -trailing.length) : rawPath
    const name = path.split('/').pop()
    return name ? `${prefix}${name}${trailing}` : match
  })
}
