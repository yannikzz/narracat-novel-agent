import { AlertCircle, CirclePause } from 'lucide-react'
import { Link } from 'react-router'
import { BrandIllustration } from '@/components/brand'
import { ReportProblemButton } from '@/components/diagnostics/ReportProblemDialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { MarkdownRenderer } from '../MarkdownRenderer'
import { AgentMarkdown } from './AgentMarkdown'
import { AgentProcessRow } from './AgentProcessRow'
import { AgentQuestionCard } from './AgentQuestionCard'
import { AgentSubagentGroupRow } from './AgentSubagentGroupRow'
import { AgentToolCallRow } from './AgentToolCallRow'
import type { AgentMessagePart } from '@shared/types/agent'

export function AgentPartView({ part, threadId }: { part: AgentMessagePart; threadId?: string }) {
  if (part.type === 'text') {
    if (part.status === 'running') {
      return <AgentRunningText text={part.text} />
    }

    return <AgentMarkdown text={part.text} threadId={threadId} />
  }

  if (part.type === 'reasoning') {
    return (
      <AgentProcessRow
        status={part.status}
        title={getReasoningTitle(part.status)}
        detail={part.text}
      />
    )
  }

  if (part.type === 'tool-call') {
    // pi runtime 派发子 agent 用 'Task'，SDK runtime 用 'Agent'——两个 toolName 都路由到分组行
    // （无 children 时也走分组行，显示「正在准备…」，见 AgentSubagentGroupRow）。
    if (part.toolName === 'Task' || part.toolName === 'Agent') {
      return <AgentSubagentGroupRow part={part} />
    }
    return <AgentToolCallRow part={part} />
  }

  if (part.type === 'question') {
    return <AgentQuestionCard part={part} />
  }

  if (part.type === 'data') {
    return (
      <AgentProcessRow
        status={part.status}
        title={part.title}
        detail={
          part.data !== undefined ? (
            <pre className="max-h-36 min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-active p-2 font-mono text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              {JSON.stringify(part.data, null, 2)}
            </pre>
          ) : undefined
        }
      />
    )
  }

  if (part.type === 'model-service-required') {
    return <ModelServiceRequiredGuide part={part} />
  }

  return <AgentTerminalNotice part={part} />
}

function AgentTerminalNotice({ part }: { part: Extract<AgentMessagePart, { type: 'error' }> }) {
  const interrupted = part.tone === 'interrupted'
  const Icon = interrupted ? CirclePause : AlertCircle
  const detail = interrupted
    ? '上次关闭 App 时，这项任务还没有完成。已完成的内容仍然保留。'
    : part.detail

  return (
    <div
      className="flex max-w-full items-start gap-2.5 rounded-row bg-active/60 px-3 py-2.5"
      data-agent-terminal-notice={interrupted ? 'interrupted' : 'failed'}
      role="status"
    >
      <span
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full',
          interrupted ? 'bg-warning/10 text-warning' : 'bg-destructive/10 text-destructive',
        )}
        aria-hidden
      >
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
        <div className="text-sm font-medium leading-5 text-foreground">{part.title}</div>
        {detail && (
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{detail}</div>
        )}
      </div>
      {/* 出错当场就能报：描述预填失败原因，日志尾里正好是这次 run 的 warn/error。中断态不是 bug，不给入口。 */}
      {!interrupted && (
        <ReportProblemButton
          variant="ghost"
          size="xs"
          className="shrink-0 text-muted-foreground"
          initialDescription={`运行失败：${part.detail ?? ''}`.trim()}
        />
      )}
    </div>
  )
}

function ModelServiceRequiredGuide({
  part,
}: {
  part: Extract<AgentMessagePart, { type: 'model-service-required' }>
}) {
  return (
    <div
      className="flex max-w-full items-center gap-3 rounded-card border border-border bg-surface px-3 py-3"
      data-agent-model-service-guide="true"
    >
      <BrandIllustration purpose="model-service-needed" size="sm" decorative className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium leading-tight text-foreground">{part.title}</div>
        <div className="mt-1 text-xs leading-5 text-muted-foreground">{part.detail}</div>
      </div>
      <Button asChild size="sm" className="shrink-0" data-agent-model-service-settings-link="true">
        <Link to="/settings?section=model" state={{ from: '/workbench' }}>打开模型服务</Link>
      </Button>
    </div>
  )
}

function AgentRunningText({ text }: { text: string }) {
  return (
    <div className="min-w-0 w-full max-w-full overflow-hidden" data-agent-running-markdown="true">
      <MarkdownRenderer text={text} variant="conversation" />
    </div>
  )
}

export function getReasoningTitle(status: AgentMessagePart['status']): string {
  if (status === 'running') return '思考中...'
  if (status === 'failed') return '思考失败'
  return '已完成思考'
}
