import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronUp, MessageSquarePlus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { AgentComposer } from './agent/AgentComposer'
import { AgentRunStatus } from './agent/AgentRunStatus'
import { AgentStepsView } from './agent/AgentStepsView'
import { AgentThreadView } from './agent/AgentThreadView'
import { WritingOperationView } from './agent/WritingOperationView'
import { cn } from '@/lib/cn'
import { formatAgentRunElapsed, getAgentPanelStatus, getAgentSteps } from '@/lib/agent-panel'
import { useAgentStore } from '@/lib/agent-store'
import { startNewAgentConversation } from '@/lib/ipc'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { AgentThread } from '@shared/types/agent'

export function getAgentStepsTogglePresentation(stepsExpanded: boolean): {
  iconDirection: 'down' | 'up'
  label: string
} {
  return stepsExpanded
    ? { iconDirection: 'up', label: '收起执行步骤' }
    : { iconDirection: 'down', label: '展开执行步骤' }
}

export function isNewConversationDisabled(thread: AgentThread | undefined): boolean {
  return !thread || thread.messages.length === 0 || Boolean(thread.activeRun)
}

export function AgentPanel({ threadId }: { threadId?: string } = {}) {
  const activeThreadId = useAgentStore((state) => state.activeThreadId)
  const scopedThreadId = threadId ?? activeThreadId
  const thread = useAgentStore((state) => state.threadsById[scopedThreadId])

  return <AgentPanelContent thread={thread} threadId={scopedThreadId} />
}

export function AgentPanelContent({
  thread,
  threadId,
}: {
  thread: AgentThread | undefined
  threadId?: string
}) {
  const [stepsExpanded, setStepsExpanded] = useState(false)
  const [panelTabSelection, setPanelTabSelection] = useState<{
    scope: string
    value: 'conversation' | 'progress'
  }>({ scope: '', value: 'conversation' })
  const [composerExpanded, setComposerExpanded] = useState(false)
  const composerWrapRef = useRef<HTMLDivElement>(null)
  const conversationTabRef = useRef<HTMLButtonElement>(null)
  const progressTabRef = useRef<HTMLButtonElement>(null)
  const [collapsedComposerHeight, setCollapsedComposerHeight] = useState(0)
  const scopedThreadId = threadId ?? thread?.id
  const activeRun = thread?.activeRun ?? null
  const status = getAgentPanelStatus(thread)
  const steps = getAgentSteps(thread)
  const hasTaskPlan = steps.length > 0
  const stepsToggle = getAgentStepsTogglePresentation(stepsExpanded)
  const StepsToggleIcon = stepsToggle.iconDirection === 'up' ? ChevronUp : ChevronDown
  const replaceThreadFromSnapshot = useAgentStore((state) => state.replaceThreadFromSnapshot)
  const newConversationDisabled = isNewConversationDisabled(thread)
  const showInterruptedRecovery =
    thread?.lastRun?.status === 'interrupted' && thread.lastRun.command !== 'freeform'
  const panelTabScope = showInterruptedRecovery ? `${scopedThreadId}:${thread.lastRun?.id ?? ''}` : ''
  const focusedQuestionRequestId = useAgentStore(
    (state) => state.focusedQuestionRequestIdsByThreadId[scopedThreadId ?? ''],
  )
  const selectedPanelTab =
    panelTabSelection.scope === panelTabScope ? panelTabSelection.value : 'conversation'
  // 通知定位到等待回答的问题时，在同一 render 内先让对话可见，避免隐藏面板消费并清掉定位请求。
  const activePanelTab =
    showInterruptedRecovery && focusedQuestionRequestId ? 'conversation' : selectedPanelTab
  const panelTabsId = useId()
  const conversationTabId = `${panelTabsId}-conversation-tab`
  const conversationPanelId = `${panelTabsId}-conversation-panel`
  const progressTabId = `${panelTabsId}-progress-tab`
  const progressPanelId = `${panelTabsId}-progress-panel`
  const [confirmNewConversationOpen, setConfirmNewConversationOpen] = useState(false)
  const [startingNewConversation, setStartingNewConversation] = useState(false)
  const newConversationRequestIdRef = useRef<string | null>(null)

  const handleNewConversation = () => {
    if (!scopedThreadId || newConversationDisabled) return
    newConversationRequestIdRef.current = crypto.randomUUID()
    setConfirmNewConversationOpen(true)
  }

  // 二次确认后由主进程原子完成当前 session 失效、旧段封存、新段开启与唯一 divider 提交。
  const confirmNewConversation = async () => {
    if (!scopedThreadId || startingNewConversation) return
    const requestId = newConversationRequestIdRef.current ?? crypto.randomUUID()
    newConversationRequestIdRef.current = requestId
    setStartingNewConversation(true)
    try {
      const snapshot = await startNewAgentConversation({
        threadId: scopedThreadId,
        requestId,
      })
      replaceThreadFromSnapshot(snapshot)
    } catch (error) {
      console.error('[workbench] 开始新对话失败', error)
      toast.error('开始新对话失败，请重试')
      setStartingNewConversation(false)
      return
    }
    newConversationRequestIdRef.current = null
    setStartingNewConversation(false)
    setConfirmNewConversationOpen(false)
  }

  const updateNewConversationDialog = (open: boolean) => {
    if (!open && startingNewConversation) return
    if (!open) newConversationRequestIdRef.current = null
    setConfirmNewConversationOpen(open)
  }

  // 折叠态量取输入框在流内的真实高度，作为展开时的占位高度；
  // 展开时输入框转为底部浮层（脱离 flex 流），靠这个等高占位让历史区保持满高、不跳动。
  useEffect(() => {
    const el = composerWrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      if (!composerExpanded) setCollapsedComposerHeight(el.offsetHeight)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [composerExpanded])

  // 将通知触发的临时切换固化为用户当前选择；问题卡清掉请求后仍留在对话页。
  useEffect(() => {
    if (!showInterruptedRecovery || !focusedQuestionRequestId) return
    setPanelTabSelection({ scope: panelTabScope, value: 'conversation' })
  }, [focusedQuestionRequestId, panelTabScope, showInterruptedRecovery])

  const selectPanelTab = (value: 'conversation' | 'progress') => {
    setPanelTabSelection({ scope: panelTabScope, value })
  }

  const handlePanelTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    value: 'conversation' | 'progress',
  ) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const nextValue = value === 'conversation' ? 'progress' : 'conversation'
    selectPanelTab(nextValue)
    ;(nextValue === 'conversation' ? conversationTabRef : progressTabRef).current?.focus()
  }

  return (
    <section className="relative flex h-full min-h-0 flex-col overflow-hidden bg-workspace">
      {/* 方案 A（上下分区）后本头部位于 caption 带下方，右缘不再需要
          --titlebar-inset-right 让位——保留会把「新对话」按钮推离卡片右缘 145px。 */}
      <header
        className="relative z-20 flex h-14 shrink-0 items-center justify-between gap-3 border border-border border-x-0 border-t-0 bg-workspace pl-[0.875rem] pr-[0.875rem] py-2.5 [-webkit-app-region:drag]"
        data-agent-panel-titlebar="true"
      >
        <div className="flex min-w-0 items-center gap-2">
          <AgentRunStatus status={status} />
          {activeRun && <AgentRunElapsed startedAt={activeRun.startedAt} />}
        </div>

        <div className="flex shrink-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
          {hasTaskPlan && (
            <IconTooltip label={stepsToggle.label} side="bottom" align="end">
              <Button
                type="button"
                variant={stepsExpanded ? 'secondary' : 'ghost'}
                size="icon"
                className={cn(
                  'size-8 rounded-full hover:text-foreground [-webkit-app-region:no-drag] [&_svg]:size-4',
                  stepsExpanded ? 'text-foreground' : 'text-muted-foreground'
                )}
                onClick={() => setStepsExpanded((value) => !value)}
                aria-label={stepsToggle.label}
                aria-pressed={stepsExpanded}
                data-agent-steps-toggle-icon={stepsToggle.iconDirection}
              >
                <StepsToggleIcon className="size-4" />
              </Button>
            </IconTooltip>
          )}
          <IconTooltip label="开始新对话" side="bottom" align="end">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 rounded-full text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag] [&_svg]:size-4"
              onClick={handleNewConversation}
              aria-label="开始新对话"
              disabled={newConversationDisabled}
              data-agent-new-conversation="true"
            >
              <MessageSquarePlus className="size-4" />
            </Button>
          </IconTooltip>
        </div>
      </header>

      {stepsExpanded && hasTaskPlan && <AgentStepsView steps={steps} />}
      <div
        className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden"
        data-agent-panel-tabs={showInterruptedRecovery ? 'true' : undefined}
      >
        {showInterruptedRecovery && (
          <div
            role="tablist"
            className="flex h-10 w-full shrink-0 items-center justify-start border-b border-border px-3.5 text-muted-foreground"
            aria-label="Agent 面板视图"
          >
            <button
              ref={conversationTabRef}
              type="button"
              role="tab"
              id={conversationTabId}
              aria-controls={conversationPanelId}
              aria-selected={activePanelTab === 'conversation'}
              tabIndex={activePanelTab === 'conversation' ? 0 : -1}
              className={cn(
                'relative h-full flex-none px-3 text-xs font-medium transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
                activePanelTab === 'conversation' &&
                  'text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-foreground',
              )}
              onClick={() => selectPanelTab('conversation')}
              onKeyDown={(event) => handlePanelTabKeyDown(event, 'conversation')}
            >
              对话
            </button>
            <button
              ref={progressTabRef}
              type="button"
              role="tab"
              id={progressTabId}
              aria-controls={progressPanelId}
              aria-selected={activePanelTab === 'progress'}
              tabIndex={activePanelTab === 'progress' ? 0 : -1}
              className={cn(
                'relative h-full flex-none px-3 text-xs font-medium transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
                activePanelTab === 'progress' &&
                  'text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-foreground',
              )}
              onClick={() => selectPanelTab('progress')}
              onKeyDown={(event) => handlePanelTabKeyDown(event, 'progress')}
            >
              进度
            </button>
          </div>
        )}

        <div
          role={showInterruptedRecovery ? 'tabpanel' : undefined}
          id={showInterruptedRecovery ? conversationPanelId : undefined}
          aria-labelledby={showInterruptedRecovery ? conversationTabId : undefined}
          hidden={showInterruptedRecovery && activePanelTab !== 'conversation'}
          className={cn(
            'relative min-h-0 flex-1 flex-col',
            showInterruptedRecovery && activePanelTab !== 'conversation' ? 'hidden' : 'flex',
          )}
          data-agent-panel-view="conversation"
        >
          <AgentThreadView threadId={scopedThreadId} />

          {/* 展开为浮层时，在流内留等高占位，历史区高度不变、插图不挪动 */}
          {composerExpanded && (
            <div aria-hidden className="shrink-0" style={{ height: collapsedComposerHeight }} />
          )}
          <div
            ref={composerWrapRef}
            className={cn('z-30', composerExpanded ? 'absolute inset-x-0 bottom-0' : 'relative')}
          >
            <AgentComposer
              key={scopedThreadId}
              threadId={scopedThreadId}
              elevated
              flushTop={false}
              showQuickActions={false}
              onExpandedChange={setComposerExpanded}
            />
          </div>
        </div>

        {showInterruptedRecovery && (
          <div
            role="tabpanel"
            id={progressPanelId}
            aria-labelledby={progressTabId}
            hidden={activePanelTab !== 'progress'}
            className={cn(
              'min-h-0 flex-1 overflow-hidden',
              activePanelTab === 'progress' ? 'block' : 'hidden',
            )}
            data-agent-panel-view="progress"
          >
            <WritingOperationView thread={thread} threadId={scopedThreadId} />
          </div>
        )}
      </div>

      <Dialog open={confirmNewConversationOpen} onOpenChange={updateNewConversationDialog}>
        <DialogContent className="sm:max-w-[400px]" data-agent-new-conversation-confirm="true">
          <DialogHeader>
            <DialogTitle>开始新对话？</DialogTitle>
            <DialogDescription>AI 将不再记得上面的聊天（历史仍可往上看）。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                取消
              </Button>
            </DialogClose>
            <Button type="button" onClick={confirmNewConversation} disabled={startingNewConversation}>
              {startingNewConversation ? '正在开始…' : '开始新对话'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function AgentRunElapsed({ startedAt }: { startedAt: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <span className="shrink-0 font-mono text-xs tabular text-hint-foreground" data-agent-run-elapsed="true">
      {formatAgentRunElapsed(nowMs - Date.parse(startedAt))}
    </span>
  )
}
