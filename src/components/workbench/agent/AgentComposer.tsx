import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { toast } from 'sonner'
import {
  ArrowUp,
  BookMarked,
  BookOpen,
  CircleAlert,
  Command,
  DatabaseZap,
  FileCog,
  FileSearch,
  ListTree,
  Maximize2,
  Minimize2,
  MessageSquareText,
  PenLine,
  RefreshCcw,
  Square,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useConfirmDialog } from '@/components/ui/confirm-dialog'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentComposerChip } from './AgentComposerChip'
import { AgentModelSwitcher } from './AgentModelSwitcher'
import {
  createAgentRunRequest,
  createAgentComposerAdjustPrompt,
  createAgentComposerReferencePrompt,
  filterAgentSlashCommands,
  getAgentComposerAdjustPlaceholder,
  getAgentComposerMenuActions,
  getAgentQuickActionAgentLabel,
  getAgentQuickActionCommandLabel,
  getAgentQuickActionChipLabel,
  getAgentQuickActionMenuDescription,
  getAgentQuickActionMenuLabel,
  getAgentQuickActionPlaceholder,
  isAgentComposerChipDeleteKey,
  isAgentComposerSendKey,
  isAgentComposerSlashDraft,
  isAgentComposerSlashCommandMenuOpen,
  resolveAgentComposerRunAction,
} from '@/lib/agent-commands'
import { detectSideEffectIntent } from '@/lib/agent-intent'
import { AGENT_RUN_STALL_HINT_MS, isAgentRunStalled } from '@/lib/agent-panel'
import { AGENT_BODY_CLASS } from '@/design-system'
import { cn } from '@/lib/cn'
import { useComposerExpandHeight } from '@/lib/use-composer-expand-height'
import { cancelAgentRun, getPendingMemorySync, listManuscriptDrafts, startAgentRun } from '@/lib/ipc'
import { useAgentStore } from '@/lib/agent-store'
import { useNovelStore } from '@/lib/novel-store'
import { getWritePrerequisiteGuidance } from '@/lib/novel-recovery'
import { buildPendingSyncWriteConfirm, buildPendingSyncWriteWarning } from '@/lib/pending-memory-sync-gate'
import {
  buildManuscriptDraftWarnConfirm,
  commandNeedsManuscriptDraftCheck,
  inferChapterNumber,
  resolveManuscriptDraftGate,
} from '@/lib/manuscript-draft-gate'
import type { AgentComposerHandoff, AgentComposerReferenceContext, AgentQuickAction } from '@/types/agent'

const QUICK_ACTION_ICON_BY_VALUE: Record<AgentQuickAction, LucideIcon> = {
  setup: Sparkles,
  reference: BookMarked,
  world: BookOpen,
  plan: ListTree,
  'write-next': PenLine,
  'recover-write': RefreshCcw,
  rewrite: RefreshCcw,
  review: FileSearch,
  'revise-premise': FileCog,
  'sync-chapter-memory': DatabaseZap,
}

const QUICK_ACTION_VALUES: AgentQuickAction[] = getAgentComposerMenuActions()

const QUICK_ACTIONS: Array<{ value: AgentQuickAction; icon: LucideIcon }> = QUICK_ACTION_VALUES.map((value) => ({
  value,
  icon: QUICK_ACTION_ICON_BY_VALUE[value],
}))

export function AgentComposer({
  floating = false,
  elevated = floating,
  flushTop = false,
  showQuickActions = true,
  threadId,
  onExpandedChange,
}: {
  floating?: boolean
  elevated?: boolean
  flushTop?: boolean
  showQuickActions?: boolean
  threadId?: string
  onExpandedChange?: (expanded: boolean) => void
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const composerRootRef = useRef<HTMLElement>(null)
  const [draft, setDraft] = useState('')
  const [selectedAction, setSelectedAction] = useState<AgentQuickAction | null>(null)
  const [currentHandoff, setCurrentHandoff] = useState<AgentComposerHandoff | null>(null)
  const [pendingHandoff, setPendingHandoff] = useState<AgentComposerHandoff | null>(null)
  const [dismissedSuggestionDraft, setDismissedSuggestionDraft] = useState('')
  const [commandMenuOpen, setCommandMenuOpen] = useState(false)
  const [commandTooltipOpen, setCommandTooltipOpen] = useState(false)
  const [suppressCommandTooltip, setSuppressCommandTooltip] = useState(false)
  const [slashCommandFocusIndex, setSlashCommandFocusIndex] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const { confirm, confirmDialog } = useConfirmDialog()
  const [expanded, setExpanded] = useState(false)
  const [heightAnimating, setHeightAnimating] = useState(false)
  const activeThreadId = useAgentStore((state) => state.activeThreadId)
  const scopedThreadId = threadId ?? activeThreadId
  const activeRun = useAgentStore((state) => state.threadsById[scopedThreadId]?.activeRun ?? null)
  const composerHandoffRequest = useAgentStore((state) => state.composerHandoffRequestsByThreadId[scopedThreadId])
  const clearComposerHandoffRequest = useAgentStore((state) => state.clearComposerHandoffRequest)
  const activeProject = useNovelStore((state) => state.activeProject)
  const isRunning = Boolean(activeRun)
  const canCancel =
    activeRun?.status === 'accepted' || activeRun?.status === 'running' || activeRun?.status === 'waiting-user'
  const reduceMotion = useReducedMotion()
  const expandedHeight = useComposerExpandHeight(composerRootRef)

  useEffect(() => {
    if (isRunning) setExpanded(false)
  }, [isRunning])

  // 把展开态通知父级布局：展开时输入框转为底部浮层覆盖历史，而非挤压历史区。
  useEffect(() => {
    onExpandedChange?.(expanded)
  }, [expanded, onExpandedChange])

  // 长时间无响应提示：运行时每 30s 刷新当前时间，据「距最后事件超 20 分钟」判定可能卡住。
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!isRunning) return
    setNowMs(Date.now())
    const id = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [isRunning])
  const runStalled = isRunning && isAgentRunStalled(activeRun, nowMs)
  const normalizedDraft = draft.trim()
  const suggestedAction =
    !isRunning && !selectedAction && normalizedDraft !== dismissedSuggestionDraft
      ? detectSideEffectIntent(normalizedDraft)
      : null
  const writeGuidance = getWritePrerequisiteGuidance(activeProject)
  const effectiveAction = resolveAgentComposerRunAction({ selectedAction, suggestedAction })
  const blocksEffectiveAction = effectiveAction === 'write-next' && writeGuidance.blocked
  const blocksHandoffRequirement = Boolean(currentHandoff?.adjust && normalizedDraft.length === 0)
  const slashCommandMenuOpen = isAgentComposerSlashCommandMenuOpen({
    draft,
    selectedAction,
    isRunning,
  })
  const instructionMenuOpen = commandMenuOpen || slashCommandMenuOpen
  const slashCommandActions = instructionMenuOpen
    ? slashCommandMenuOpen
      ? filterAgentSlashCommands(draft, QUICK_ACTION_VALUES)
      : QUICK_ACTION_VALUES
    : []
  const composerPlaceholder = currentHandoff?.adjust
    ? getAgentComposerAdjustPlaceholder(currentHandoff.adjust)
    : getAgentQuickActionPlaceholder(selectedAction)
  const canSend =
    canCancel ||
    (!instructionMenuOpen &&
      !blocksEffectiveAction &&
      !blocksHandoffRequirement &&
      (Boolean(effectiveAction) || normalizedDraft.length > 0))

  useEffect(() => {
    setSlashCommandFocusIndex(0)
  }, [draft, instructionMenuOpen])

  // 点击指令面板与触发器之外关闭菜单：⌘ 菜单直接收起；
  // / 菜单仅当点击落在输入框之外时清空草稿（等同 Esc），避免在框内编辑命令时误删。
  useEffect(() => {
    if (!instructionMenuOpen) return

    function handleOutsidePointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement | null
      if (!target) return
      if (
        target.closest('[data-agent-command-menu-popover]') ||
        target.closest('[data-agent-command-menu-trigger]') ||
        target.closest('[data-agent-composer-command-slot]')
      ) {
        return
      }

      if (commandMenuOpen) closeCommandMenu({ suppressTooltip: true })
      if (slashCommandMenuOpen && !composerRootRef.current?.contains(target)) {
        setEditorDraft('')
      }
    }

    document.addEventListener('pointerdown', handleOutsidePointerDown)
    return () => document.removeEventListener('pointerdown', handleOutsidePointerDown)
  }, [instructionMenuOpen, commandMenuOpen, slashCommandMenuOpen])

  useEffect(() => {
    if (!composerHandoffRequest) return

    if (isRunning) {
      clearComposerHandoffRequest(scopedThreadId)
      return
    }

    const sameHandoff = isSameComposerHandoff(currentHandoff, composerHandoffRequest)

    if (composerHandoffRequest.preserveDraft) {
      applyComposerCommandHandoff(composerHandoffRequest)
      clearComposerHandoffRequest(scopedThreadId)
      return
    }

    if (sameHandoff) {
      editorRef.current?.focus()
      clearComposerHandoffRequest(scopedThreadId)
      return
    }

    if (normalizedDraft.length > 0 && draft !== composerHandoffRequest.prompt) {
      setPendingHandoff(composerHandoffRequest)
      clearComposerHandoffRequest(scopedThreadId)
      return
    }

    applyComposerHandoff(composerHandoffRequest)
    clearComposerHandoffRequest(scopedThreadId)
  }, [
    clearComposerHandoffRequest,
    composerHandoffRequest,
    currentHandoff?.sourceActionId,
    currentHandoff?.target?.objectId,
    currentHandoff?.target?.sectionId,
    currentHandoff?.target?.tabId,
    draft,
    isRunning,
    normalizedDraft.length,
    scopedThreadId,
  ])

  async function handleSubmit(options: { forceFreeform?: boolean; actionOverride?: AgentQuickAction | null } = {}) {
    if (submitting) return

    if (activeRun) {
      setSubmitting(true)
      try {
        await cancelAgentRun(activeRun.id)
      } catch (error) {
        console.error(error)
        toast.error('停止失败，请重试')
      } finally {
        setSubmitting(false)
      }
      return
    }

    const runAction =
      options.actionOverride !== undefined
        ? options.actionOverride
        : resolveAgentComposerRunAction({
            selectedAction,
            suggestedAction,
            forceFreeform: options.forceFreeform,
          })
    const blocksRunAction = runAction === 'write-next' && writeGuidance.blocked
    const blocksHandoffRun = Boolean(
      currentHandoff?.adjust && runAction === currentHandoff.command && normalizedDraft.length === 0,
    )
    const hasRunnableInput = Boolean(runAction) || normalizedDraft.length > 0

    if (blocksRunAction || blocksHandoffRun || !hasRunnableInput) {
      return
    }

    setSubmitting(true)
    try {
      if (runAction && activeProject?.path && commandNeedsManuscriptDraftCheck(runAction)) {
        let manuscriptDrafts
        try {
          manuscriptDrafts = await listManuscriptDrafts(activeProject.path)
        } catch (error) {
          console.error(error)
          toast.error('检查正文恢复草稿失败，请重试')
          return
        }
        const draftGate = resolveManuscriptDraftGate({
          command: runAction,
          drafts: manuscriptDrafts,
          selectedChapter: currentHandoff?.selectedChapter ?? inferChapterNumber(normalizedDraft),
        })
        if (draftGate.kind === 'block') {
          toast.error(draftGate.message)
          return
        }
        if (
          draftGate.kind === 'warn' &&
          !(await confirm(buildManuscriptDraftWarnConfirm(draftGate.message)))
        ) {
          return
        }
      }

      if (runAction === 'write-next' && activeProject?.path) {
        const pendingSyncWarning = await resolveWriteNextPendingSyncWarning(activeProject.path)
        if (pendingSyncWarning && !(await confirm(buildPendingSyncWriteConfirm(pendingSyncWarning)))) {
          return
        }
      }

      const isAdjustRun = Boolean(currentHandoff?.adjust && runAction === currentHandoff.command)
      const basePrompt = isAdjustRun && currentHandoff?.adjust
        ? createAgentComposerAdjustPrompt(currentHandoff.adjust, draft)
        : draft
      const prompt = createAgentComposerReferencePrompt({
        prompt: basePrompt,
        referenceContext: currentHandoff?.referenceContext,
      })

      await startAgentRun(
        createAgentRunRequest({
          threadId: scopedThreadId,
          action: runAction,
          prompt,
          displayPrompt: isAdjustRun ? normalizedDraft : undefined,
          projectPath: activeProject?.path,
          selectedChapter: currentHandoff?.selectedChapter,
          target: currentHandoff?.target,
        })
      )
      setEditorDraft('')
      setCurrentHandoff(null)
      setDismissedSuggestionDraft('')
      setExpanded(false)
      setSelectedAction(null)
    } catch (error) {
      console.error(error)
      toast.error('发送失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  function handleQuickAction(action: AgentQuickAction) {
    selectComposerAction(action)
  }

  function selectComposerAction(action: AgentQuickAction) {
    setSelectedAction(action)
    setCurrentHandoff(null)
    closeCommandMenu({ suppressTooltip: true })
    setEditorDraft(resolveDraftAfterCommandSelection(draft), { focus: true })
  }

  function clearSelectedAction() {
    setDismissedSuggestionDraft(normalizedDraft)
    setSelectedAction(null)
    setCurrentHandoff(null)
    editorRef.current?.focus()
  }

  function clearReferenceContext() {
    if (!currentHandoff?.referenceContext) return
    setCurrentHandoff({ ...currentHandoff, referenceContext: undefined })
    editorRef.current?.focus()
  }

  function applyComposerHandoff(handoff: AgentComposerHandoff) {
    setSelectedAction(handoff.command)
    setCurrentHandoff(handoff)
    closeCommandMenu()
    setPendingHandoff(null)
    setDismissedSuggestionDraft('')
    setEditorDraft(handoff.prompt, { focus: true })
  }

  function applyComposerCommandHandoff(handoff: AgentComposerHandoff) {
    setSelectedAction(handoff.command)
    setCurrentHandoff(null)
    closeCommandMenu()
    setPendingHandoff(null)
    setDismissedSuggestionDraft('')
    editorRef.current?.focus()
  }

  function closeCommandMenu(options: { suppressTooltip?: boolean } = {}) {
    setCommandMenuOpen(false)
    setCommandTooltipOpen(false)
    if (options.suppressTooltip) {
      setSuppressCommandTooltip(true)
    }
  }

  function keepCurrentDraft() {
    setPendingHandoff(null)
    editorRef.current?.focus()
  }

  function confirmSuggestedAction() {
    if (!suggestedAction) return
    void handleSubmit({ actionOverride: suggestedAction })
  }

  function sendAsFreeformChat() {
    setDismissedSuggestionDraft(normalizedDraft)
    void handleSubmit({ forceFreeform: true })
  }

  function handleEditorInput() {
    const editor = editorRef.current
    if (!editor) return

    const nextDraft = editor.innerText.replace(/\u00a0/g, ' ')

    if (commandMenuOpen) {
      closeCommandMenu()
    }

    if (nextDraft.length === 0) {
      editor.innerHTML = ''
    }

    setDraft(nextDraft)
  }

  function handleCommandTooltipOpenChange(open: boolean) {
    if (open && (instructionMenuOpen || suppressCommandTooltip)) {
      return
    }

    setCommandTooltipOpen(open)
  }

  function handleCommandTriggerPointerEnter() {
    setSuppressCommandTooltip(false)

    if (!instructionMenuOpen) {
      setCommandTooltipOpen(true)
    }
  }

  function handleCommandTriggerPointerLeave() {
    setCommandTooltipOpen(false)
  }

  function handleCommandTriggerPointerDown() {
    setCommandTooltipOpen(false)
  }

  function handleCommandTriggerBlur() {
    setSuppressCommandTooltip(false)
    setCommandTooltipOpen(false)
  }

  function toggleCommandMenu() {
    setCommandTooltipOpen(false)
    setCommandMenuOpen((open) => {
      const nextOpen = !open
      if (!nextOpen) {
        setSuppressCommandTooltip(true)
      }
      return nextOpen
    })
    editorRef.current?.focus()
  }

  function handleCommandTriggerClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation()
    toggleCommandMenu()
  }

  function setEditorDraft(nextDraft: string, options: { focus?: boolean } = {}) {
    setDraft(nextDraft)

    const editor = editorRef.current
    if (!editor) return

    editor.textContent = nextDraft

    if (options.focus) {
      editor.focus()
      moveCaretToEnd(editor)
    }
  }

  return (
    <footer ref={composerRootRef} className={cn('shrink-0', floating ? 'p-0' : flushTop ? 'p-3 pt-0' : 'p-3 pt-2')}>
      <div
        className={cn(
          'rounded-panel border border-border bg-surface p-2',
          elevated
            ? 'shadow-[var(--shadow-floating)]'
            : 'shadow-[var(--shadow-workspace)]'
        )}
      >
        {runStalled && (
          <div
            className="mb-2 flex items-start gap-2 rounded-row border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-xs text-warning"
            data-agent-stalled-hint="true"
          >
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{`Agent 已超过 ${AGENT_RUN_STALL_HINT_MS / 60_000} 分钟没有新进展，可能卡住了。可点右下角停止按钮中止，稍后可从中断处继续。`}</span>
          </div>
        )}
        {showQuickActions && (
          <div className="mb-2 grid gap-2">
            <div className="flex items-center justify-between gap-2 px-1">
              <div className="text-xs font-medium text-hint-foreground">写作指令</div>
              {selectedAction && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                  disabled={isRunning}
                  onClick={clearSelectedAction}
                >
                  清除
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_ACTIONS.map((action) => {
                const Icon = action.icon

                return (
                  <button
                    key={action.value}
                    type="button"
                    data-agent-command={action.value}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition-all duration-200 active:scale-[0.95] disabled:cursor-not-allowed disabled:opacity-55',
                      selectedAction === action.value
                        ? 'bg-active font-semibold text-foreground hover:bg-active'
                        : 'bg-active text-muted-foreground hover:bg-hover hover:text-foreground'
                    )}
                    disabled={isRunning}
                    onClick={() => handleQuickAction(action.value)}
                    aria-pressed={selectedAction === action.value}
                  >
                    <Icon className="size-3" />
                    {getAgentQuickActionMenuLabel(action.value)}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {suggestedAction && (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-row border border-primary/20 bg-primary/10 px-2.5 py-2">
            <span className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
              这看起来会写入小说文件。确认后作为“{getAgentQuickActionChipLabel(suggestedAction)}”运行。
            </span>
            <Button type="button" variant="secondary" size="xs" onClick={confirmSuggestedAction}>
              确认操作
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={sendAsFreeformChat}>
              作为对话发送
            </Button>
          </div>
        )}

        {pendingHandoff && (
          <div
            className="mb-2 flex flex-wrap items-center gap-2 rounded-row border border-warning/25 bg-warning/10 px-2.5 py-2"
            data-agent-composer-handoff-confirm="true"
          >
            <span className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">当前输入尚未发送。</span>
            <Button type="button" variant="secondary" size="xs" onClick={() => applyComposerHandoff(pendingHandoff)}>
              替换当前输入
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={keepCurrentDraft}>
              保留当前输入
            </Button>
          </div>
        )}

        {blocksEffectiveAction && (
          <div className="mb-2 rounded-row border border-destructive/25 bg-destructive/10 px-2.5 py-2">
            <div className="text-xs font-medium text-destructive">{writeGuidance.title}</div>
            <div className="mt-1 text-xs leading-4 text-muted-foreground">{writeGuidance.detail}</div>
          </div>
        )}

        <div className={`relative rounded-xl bg-transparent outline-none ${AGENT_BODY_CLASS}`}>
          {instructionMenuOpen && (
            <AgentCommandMenuPopover expanded={expanded}>
              <AgentSlashCommandMenu
                actions={slashCommandActions}
                activeIndex={slashCommandFocusIndex}
                slashTriggered={slashCommandMenuOpen}
                onSelect={selectComposerAction}
              />
            </AgentCommandMenuPopover>
          )}

          {currentHandoff?.referenceContext && (
            <AgentComposerReferencePill
              disabled={isRunning}
              referenceContext={currentHandoff.referenceContext}
              onRemove={clearReferenceContext}
            />
          )}
          <motion.div
            className={cn(
              'min-h-16 cursor-text px-2.5 py-1.5',
              !expanded && 'max-h-32',
              heightAnimating ? 'overflow-hidden' : 'overflow-y-auto',
              isRunning && 'cursor-not-allowed opacity-55'
            )}
            data-agent-composer-text-area="true"
            data-expanded={expanded}
            initial={false}
            animate={{ height: expanded ? expandedHeight : 'auto' }}
            transition={reduceMotion ? { duration: 0 } : { type: 'spring', duration: 0.28, bounce: 0.2 }}
            onAnimationStart={() => setHeightAnimating(true)}
            onAnimationComplete={() => setHeightAnimating(false)}
            onClick={() => editorRef.current?.focus()}
          >
            <div
              ref={editorRef}
              role="textbox"
              aria-label="向 Agent 描述任务"
              aria-multiline="true"
              data-placeholder={composerPlaceholder}
              className={cn(
                'min-h-16 w-full whitespace-pre-wrap break-words outline-none',
                'empty:before:pointer-events-none empty:before:text-hint-foreground empty:before:content-[attr(data-placeholder)]'
              )}
              contentEditable={isRunning ? false : 'plaintext-only'}
              suppressContentEditableWarning
              onInput={handleEditorInput}
              onKeyDown={(event) => {
                if (
                  instructionMenuOpen &&
                  (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault()
                  if (slashCommandActions.length === 0) return

                  setSlashCommandFocusIndex((currentIndex) => {
                    const lastIndex = slashCommandActions.length - 1

                    if (event.key === 'ArrowDown') return currentIndex >= lastIndex ? 0 : currentIndex + 1
                    return currentIndex <= 0 ? lastIndex : currentIndex - 1
                  })
                  return
                }

                if (instructionMenuOpen && event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  const focusedAction = slashCommandActions[slashCommandFocusIndex] ?? slashCommandActions[0]
                  if (focusedAction) selectComposerAction(focusedAction)
                  return
                }

                if (instructionMenuOpen && event.key === 'Escape') {
                  event.preventDefault()
                  closeCommandMenu({ suppressTooltip: true })
                  if (slashCommandMenuOpen) setEditorDraft('', { focus: true })
                  return
                }

                if (
                  isAgentComposerChipDeleteKey({
                    key: event.key,
                    hasChip: Boolean(selectedAction),
                    caretAtStart: isEditorCaretAtStart(editorRef.current),
                    isComposing: event.nativeEvent.isComposing,
                  })
                ) {
                  event.preventDefault()
                  clearSelectedAction()
                  return
                }

                if (
                  isAgentComposerSendKey({
                    key: event.key,
                    shiftKey: event.shiftKey,
                    isComposing: event.nativeEvent.isComposing,
                  })
                ) {
                  event.preventDefault()
                  void handleSubmit()
                }
              }}
            />
          </motion.div>
          <div className="mt-1 flex h-9 items-center gap-2 px-1" data-agent-composer-action-bar="true">
            {!isRunning &&
              (selectedAction ? (
                <div className="flex min-w-0 items-center" data-agent-composer-command-slot="true">
                  <AgentComposerChip
                    label={getAgentQuickActionChipLabel(selectedAction)}
                    className="h-7 max-w-[11rem] gap-1 px-2"
                    disabled={isRunning}
                    tone="command"
                    title={getAgentQuickActionMenuLabel(selectedAction)}
                    onActivate={toggleCommandMenu}
                    onRemove={clearSelectedAction}
                  />
                </div>
              ) : (
                <TooltipProvider>
                  <IconTooltip
                    label="选择 Agent 指令"
                    side="top"
                    align="start"
                    open={commandTooltipOpen}
                    onOpenChange={handleCommandTooltipOpenChange}
                  >
                    <Button
                      type="button"
                      size="icon-sm"
                      className="rounded-full"
                      variant={commandMenuOpen ? 'secondary' : 'ghost'}
                      onClick={handleCommandTriggerClick}
                      onPointerEnter={handleCommandTriggerPointerEnter}
                      onPointerLeave={handleCommandTriggerPointerLeave}
                      onPointerDown={handleCommandTriggerPointerDown}
                      onBlur={handleCommandTriggerBlur}
                      aria-label="选择 Agent 指令"
                      aria-expanded={instructionMenuOpen}
                      data-agent-command-menu-trigger="true"
                    >
                      <Command className="size-4" />
                    </Button>
                  </IconTooltip>
                </TooltipProvider>
              ))}
            <div className="min-w-0 flex-1" />
            {!isRunning ? <AgentModelSwitcher /> : null}
            {!isRunning && (
              <TooltipProvider>
                <IconTooltip label={expanded ? '收起输入框' : '展开输入框'} side="top" align="end">
                  <Button
                    type="button"
                    size="icon-sm"
                    className="rounded-full"
                    variant="ghost"
                    onClick={() => setExpanded((value) => !value)}
                    aria-label={expanded ? '收起输入框' : '展开输入框'}
                    aria-pressed={expanded}
                    data-agent-composer-expand-toggle="true"
                  >
                    {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                  </Button>
                </IconTooltip>
              </TooltipProvider>
            )}
            <Button
              type="button"
              size="icon-sm"
              className="rounded-full"
              variant={isRunning ? 'secondary' : 'default'}
              disabled={!canSend || submitting}
              onClick={() => void handleSubmit()}
              aria-label={activeRun?.status === 'cancelling' ? '正在停止' : isRunning ? '停止运行' : '发送任务'}
            >
              {isRunning ? <Square className="size-3 fill-current" /> : <ArrowUp className="size-4" />}
            </Button>
          </div>
        </div>
      </div>
      {confirmDialog}
    </footer>
  )
}

export function AgentSlashCommandMenu({
  actions,
  activeIndex = 0,
  slashTriggered = false,
  onSelect,
}: {
  actions: AgentQuickAction[]
  activeIndex?: number
  /** 菜单是否由用户输入 `/` 触发。仅此时右侧展示斜杠命令原型（用户已在用斜杠语法，展示才有意义）；⌘ 按钮触发默认署名负责的 Agent 人读名（ADR-0016，不向作者裸露命令语法）。 */
  slashTriggered?: boolean
  onSelect: (action: AgentQuickAction) => void
}) {
  return (
    <div
      className="max-h-64 overflow-y-auto rounded-panel border border-border bg-popover p-1 shadow-[var(--shadow-floating)]"
      data-agent-slash-command-menu="true"
      role="listbox"
      aria-label="Agent 指令"
    >
      {actions.length > 0 ? (
        actions.map((action, index) => {
          const Icon = QUICK_ACTION_ICON_BY_VALUE[action]
          const active = index === activeIndex
          const description = getAgentQuickActionMenuDescription(action)
          const commandLabel = getAgentQuickActionCommandLabel(action)
          const showsSlashCommand = slashTriggered && commandLabel.startsWith('/')

          return (
            <button
              key={action}
              type="button"
              className={cn(
                'flex w-full min-w-0 items-start gap-2 rounded-row px-2 py-2 text-left transition-colors duration-200 hover:bg-hover',
                active && 'bg-hover text-foreground'
              )}
              data-agent-slash-command={action}
              data-agent-slash-command-active={active ? 'true' : undefined}
              onClick={() => onSelect(action)}
              role="option"
              aria-selected={active}
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span
                className="flex min-w-0 flex-1 flex-col gap-0.5"
                data-agent-slash-command-content="true"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span
                    className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
                    data-agent-slash-command-label="true"
                  >
                    {getAgentQuickActionMenuLabel(action)}
                  </span>
                  <span
                    className={cn(
                      'ml-auto shrink-0 truncate text-xs text-muted-foreground',
                      showsSlashCommand && 'font-mono'
                    )}
                    data-agent-slash-command-hint="true"
                  >
                    {showsSlashCommand ? commandLabel : getAgentQuickActionAgentLabel(action)}
                  </span>
                </span>
                {description && (
                  <span className="truncate text-xs text-muted-foreground" data-agent-slash-command-description="true">
                    {description}
                  </span>
                )}
              </span>
            </button>
          )
        })
      ) : (
        <div className="px-2 py-2 text-xs text-muted-foreground">没有匹配指令</div>
      )}
    </div>
  )
}

function AgentComposerReferencePill({
  disabled,
  onRemove,
  referenceContext,
}: {
  disabled: boolean
  onRemove: () => void
  referenceContext: AgentComposerReferenceContext
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="group mb-1.5 inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-border bg-active/45 px-2.5 text-xs font-medium text-foreground"
          data-agent-composer-reference-context="true"
        >
          <MessageSquareText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">1 个已选文本片段</span>
          <button
            type="button"
            className="pointer-events-none ml-0.5 flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-hover hover:text-foreground group-hover:pointer-events-auto group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation()
              onRemove()
            }}
            tabIndex={-1}
            aria-label="移除引用上下文"
            data-agent-composer-reference-remove="true"
          >
            <X className="size-3" />
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent align="start" side="top" className="max-w-80 text-left">
        <span className="block truncate text-[11px] font-semibold leading-4">{referenceContext.sourceTitle}</span>
        <span className="mt-1 line-clamp-5 whitespace-pre-wrap text-[11px] leading-4 text-background/75">
          {referenceContext.text}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

export function AgentCommandMenuPopover({
  children,
  expanded = false,
}: {
  children: ReactNode
  expanded?: boolean
}) {
  return (
    <div
      className={cn(
        'absolute inset-x-0 z-50',
        // 折叠态浮在整块上方；展开态文本区很高，改为锚定动作栏上方(h-9+mt-1=2.5rem 再留 0.5rem 间隙)，避免被顶出面板顶部
        expanded ? 'bottom-12' : 'bottom-[calc(100%+0.5rem)]'
      )}
      data-agent-command-menu-popover="true"
    >
      {children}
    </div>
  )
}

function moveCaretToEnd(element: HTMLElement) {
  const selection = window.getSelection()
  const range = document.createRange()

  range.selectNodeContents(element)
  range.collapse(false)
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function isEditorCaretAtStart(element: HTMLElement | null): boolean {
  const selection = window.getSelection()

  if (!element || !selection || selection.rangeCount === 0 || !selection.isCollapsed) {
    return false
  }

  const range = selection.getRangeAt(0)

  if (!element.contains(range.startContainer)) {
    return false
  }

  const textBeforeCaret = range.cloneRange()
  textBeforeCaret.selectNodeContents(element)
  textBeforeCaret.setEnd(range.startContainer, range.startOffset)

  return textBeforeCaret.toString().length === 0
}

function isSameComposerHandoff(currentHandoff: AgentComposerHandoff | null, nextHandoff: AgentComposerHandoff): boolean {
  return (
    currentHandoff?.sourceActionId === nextHandoff.sourceActionId &&
    currentHandoff?.command === nextHandoff.command &&
    currentHandoff?.prompt === nextHandoff.prompt &&
    currentHandoff?.selectedChapter === nextHandoff.selectedChapter &&
    currentHandoff?.target?.sectionId === nextHandoff.target?.sectionId &&
    currentHandoff?.target?.tabId === nextHandoff.target?.tabId &&
    currentHandoff?.target?.objectId === nextHandoff.target?.objectId &&
    currentHandoff?.referenceContext?.sourceTitle === nextHandoff.referenceContext?.sourceTitle &&
    currentHandoff?.referenceContext?.text === nextHandoff.referenceContext?.text &&
    currentHandoff?.adjust?.targetLabel === nextHandoff.adjust?.targetLabel
  )
}

function resolveDraftAfterCommandSelection(draft: string): string {
  return isAgentComposerSlashDraft(draft) ? '' : draft
}

/**
 * composer 提交路径的「记忆待同步」拦截（终审补项）：点击时才拉取 map，避免挂 hook 用陈旧数据。
 * IPC 失败 fail-open——拦截是提醒不是硬闸，读不到 map 就放行，不 block 写作。
 */
async function resolveWriteNextPendingSyncWarning(projectPath: string): Promise<string | null> {
  try {
    const map = await getPendingMemorySync(projectPath)
    return buildPendingSyncWriteWarning('write-next', map)
  } catch (error) {
    console.error(error)
    return null
  }
}
