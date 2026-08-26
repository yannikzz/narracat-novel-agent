import { AgentProcessRow } from './AgentProcessRow'
import { getToolPhrase } from './tool-phrase'
import type { AgentMessagePart } from '@shared/types/agent'

type ToolCallPart = Extract<AgentMessagePart, { type: 'tool-call' }>

export function AgentToolCallRow({ part }: { part: ToolCallPart }) {
  const title = getToolDisplayTitle(part)
  const detail = getToolDetail(part)

  // 工具级错误是 LLM 自愈型瞬时噪声（换工具/重试后继续），用 warning 中性呈现；
  // 红色 danger 保留给 run 级终态失败（由独立的 error part 渲染）。
  return (
    <AgentProcessRow
      status={part.status}
      title={title}
      detail={detail}
      tone={part.status === 'failed' ? 'warning' : 'muted'}
    />
  )
}

export function getToolDisplayTitle(part: ToolCallPart): string {
  const phrase = getToolPhrase(part.toolName, part.input)
  if (part.status === 'running') return phrase.loadingLabel
  if (part.status === 'failed') return `${phrase.label} · 失败`
  return part.summary ?? phrase.label
}

function getToolDetail(part: ToolCallPart): string | undefined {
  if (part.status === 'running') return '等待工具返回结果...'
  if (part.status === 'failed') return part.error
  return part.result ?? part.summary
}
