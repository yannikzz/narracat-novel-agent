import { useState, type PointerEvent } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { AgentPanel } from './AgentPanel'
import { CapabilityPackPanel } from './CapabilityPackPanel'
import { CharacterChatBoard } from './CharacterChatBoard'
import { MemoryGraphView } from './MemoryGraphView'
import { resolveWorkbenchContentSelection, WorkbenchContentView } from './WorkbenchContentView'
import { WorkbenchStatusPanel } from './WorkbenchStatusPanel'
import {
  WORKBENCH_RESIZE_HANDLE_CLASS,
  WORKBENCH_RESIZE_HANDLE_LINE_CLASS,
} from '@/design-system'
import { TitlebarDragGutter } from '@/components/TitlebarDragGutter'
import { useConfirmDialog } from '@/components/ui/confirm-dialog'
import { createAgentRunRequest } from '@/lib/agent-commands'
import { getAgentThreadIdForProject, useAgentStore } from '@/lib/agent-store'
import { cn } from '@/lib/cn'
import { clearReferenceGuidance, listManuscriptDrafts, resetReferenceWorks, startAgentRun } from '@/lib/ipc'
import {
  buildManuscriptDraftWarnConfirm,
  commandNeedsManuscriptDraftCheck,
  resolveManuscriptDraftGate,
} from '@/lib/manuscript-draft-gate'
import { confirmLeaveManuscriptEditor, useManuscriptEditorGuard } from '@/lib/manuscript-editor-guard'
import { useNovelStore } from '@/lib/novel-store'
import { buildPendingSyncWriteConfirm, buildPendingSyncWriteWarning } from '@/lib/pending-memory-sync-gate'
import {
  REANALYZE_REFERENCE_GUIDANCE_CONFIRM,
  RESET_REFERENCE_WORKS_CONFIRM,
} from '@/lib/reference-works-confirm'
import { loadWorkbenchProject } from '@/lib/use-novel-project'
import { usePendingMemorySyncMap } from '@/lib/use-pending-memory-sync'
import { resolveDefaultChapterView } from '@/lib/workbench-chapter-state'
import { buildWorkbenchActionRegions, getWorkbenchActions } from '@/lib/workbench-actions'
import type { WorkbenchAction } from '@/lib/workbench-actions'
import {
  workbenchStageGridTemplateColumns,
  WORKBENCH_GRID_TEMPLATE_ROWS,
  WORKBENCH_PANEL_WIDTHS,
  WORKBENCH_STAGE_SINGLE_COLUMN_TEMPLATE,
  isFullWidthWorkbenchSection,
} from '@/lib/workbench-layout'
import { buildWorkbenchTargetHref } from '@/lib/workbench-selection'
import type { AgentComposerHandoff } from '@/types/agent'
import type { WorkbenchPrimarySectionId } from '@/lib/workbench-navigation'
import type { WorkbenchChapterView } from '@shared/types/workbench'

const WORKBENCH_STAGE_CARD_CLASS = 'rounded-workspace border border-border bg-workspace'

export function WorkbenchStage({
  agentWidth = WORKBENCH_PANEL_WIDTHS.agent.default,
  onAgentResizeStart,
  onSelectedChapterViewChange,
  selectedChapterView,
  selectedSectionId,
  selectedObjectId,
  selectedTabId,
}: {
  agentWidth?: number
  onAgentResizeStart?: (event: PointerEvent<HTMLDivElement>) => void
  onSelectedChapterViewChange?: (value: WorkbenchChapterView) => void
  selectedChapterView?: WorkbenchChapterView
  selectedSectionId: WorkbenchPrimarySectionId
  selectedTabId: string | null
  selectedObjectId: string | null
}) {
  const [submitting, setSubmitting] = useState(false)
  const { confirm, confirmDialog } = useConfirmDialog()
  const navigate = useNavigate()
  const project = useNovelStore((state) => state.activeProject)
  const activeWorkbenchArtifacts = useNovelStore((state) => state.activeWorkbenchArtifacts)
  const loading = useNovelStore((state) => state.loading)
  const fallbackThreadId = useAgentStore((state) => state.activeThreadId)
  const agentThreadId = project ? getAgentThreadIdForProject(project) : fallbackThreadId
  const activeRun = useAgentStore((state) => state.threadsById[agentThreadId]?.activeRun ?? null)
  const requestComposerHandoff = useAgentStore((state) => state.requestComposerHandoff)
  const { activeTab, artifacts, selectedItem } = resolveWorkbenchContentSelection({
    activeWorkbenchArtifacts,
    project,
    selectedSectionId,
    selectedObjectId,
    selectedTabId,
  })
  // 唠个嗑与记忆星图独占整个舞台：不并排 Agent 对话，也不留可拖的分隔手柄
  const isFullWidthSection = isFullWidthWorkbenchSection(selectedSectionId)
  const defaultChapterView = resolveDefaultChapterView(selectedItem)
  const chapterView = selectedItem?.kind === 'chapter' ? (selectedChapterView ?? defaultChapterView) : defaultChapterView
  const isAgentBusy = Boolean(activeRun) || submitting
  const { titlebarActions: baseTitlebarActions, emptyGuideAction } = buildWorkbenchActionRegions({
    actions: getWorkbenchActions({ project, selectedItem, artifacts, chapterView }),
    activeTab,
    agentBusy: isAgentBusy,
    artifacts,
    loading,
    sectionId: selectedSectionId,
    selectedItem,
  })

  // 正文编辑态：titlebar 整体替换为「保存/取消」，不与阅读态动作混排（少解释、降噪）。
  const manuscriptEditing = useManuscriptEditorGuard((state) => state.editing)
  const manuscriptSaving = useManuscriptEditorGuard((state) => state.saving)
  const manuscriptDirty = useManuscriptEditorGuard((state) => state.dirty)
  const manuscriptSaveVersion = useManuscriptEditorGuard((state) => state.saveVersion)
  const pendingMemorySyncMap = usePendingMemorySyncMap(project?.path, `${Boolean(activeRun)}:${manuscriptSaveVersion}`)
  const isManuscriptTextView = selectedItem?.kind === 'chapter' && chapterView === 'text'
  const titlebarActions: WorkbenchAction[] =
    manuscriptEditing && isManuscriptTextView
      ? [
          {
            id: 'manuscript-save',
            kind: 'client',
            label: '保存',
            description: '保存当前正文修改。',
            enabled: !manuscriptSaving && manuscriptDirty,
            disabledReason: manuscriptSaving ? '正在保存…' : '没有修改内容',
            placement: 'primary',
          },
          {
            id: 'manuscript-cancel',
            kind: 'client',
            label: '取消',
            description: '退出当前编辑；未保存内容可保留为恢复草稿。',
            enabled: !manuscriptSaving,
            placement: 'secondary',
          },
        ]
      : baseTitlebarActions

  function refreshProject() {
    if (project) {
      const refreshSectionId = activeTab ? selectedSectionId : undefined
      void loadWorkbenchProject(
        project.path,
        selectedItem?.chapterNumber,
        selectedItem?.id,
        refreshSectionId,
        activeTab?.id ?? selectedTabId,
        { smooth: true },
      )
    }
  }

  async function allowAgentCommandWithDrafts({
    command,
    selectedChapter,
    warnWriteNext = true,
  }: {
    command: NonNullable<WorkbenchAction['command']>
    selectedChapter?: number
    warnWriteNext?: boolean
  }): Promise<boolean> {
    if (!project || !commandNeedsManuscriptDraftCheck(command)) return true
    if (command === 'write-next' && !warnWriteNext) return true

    let drafts
    try {
      drafts = await listManuscriptDrafts(project.path)
    } catch (error) {
      console.error(error)
      toast.error('检查正文恢复草稿失败，请重试')
      return false
    }

    const gate = resolveManuscriptDraftGate({ command, drafts, selectedChapter })
    if (gate.kind === 'block') {
      toast.error(gate.message)
      return false
    }
    if (gate.kind === 'warn' && warnWriteNext) {
      return confirm(buildManuscriptDraftWarnConfirm(gate.message))
    }
    return true
  }

  function handleClientAction(action: WorkbenchAction) {
    if (action.id === 'refresh-project') {
      refreshProject()
    }

    // 纯导航：从「本章还没轮到」的空态跳到当前该写的那一章。当前视图必然是空态（没有正文可编辑），
    // 故不需要走 confirmLeaveManuscriptEditor。
    if (action.id === 'go-to-current-chapter' && project && action.target) {
      navigate(buildWorkbenchTargetHref({ project, projectPath: project.path, target: action.target }))
      return
    }

    if (
      action.id === 'edit-manuscript' ||
      action.id === 'manuscript-history' ||
      action.id === 'polish-manuscript' ||
      action.id === 'manuscript-save' ||
      action.id === 'manuscript-cancel' ||
      action.id === 'sync-chapter-memory-entry'
    ) {
      const handlers = useManuscriptEditorGuard.getState().handlers
      if (action.id === 'edit-manuscript') handlers?.startEdit?.()
      if (action.id === 'manuscript-history') handlers?.openHistory?.()
      if (action.id === 'polish-manuscript') handlers?.openPolish?.()
      if (action.id === 'manuscript-save') handlers?.save?.()
      if (action.id === 'manuscript-cancel') handlers?.cancel?.()
      if (action.id === 'sync-chapter-memory-entry') handlers?.syncMemory?.()
      return
    }

    if (action.id === 'reset-reference-works' && project) {
      void confirm(RESET_REFERENCE_WORKS_CONFIRM).then((confirmed) => {
        if (!confirmed) return

        setSubmitting(true)
        resetReferenceWorks(project.path)
          .then(() => refreshProject())
          .catch((error) => {
            console.error(error)
            toast.error('重置参考作品失败，请重试')
          })
          .finally(() => setSubmitting(false))
      })
    }
  }

  async function handleAgentAction(action: WorkbenchAction) {
    if (activeRun || submitting) {
      toast.info('Agent 正在执行任务，请等待完成后再试')
      return
    }
    if (!project || !action.command) return
    const selectedChapter =
      action.selectedChapter ?? (action.omitSelectedChapter ? undefined : selectedItem?.chapterNumber)
    if (!(await allowAgentCommandWithDrafts({ command: action.command, selectedChapter }))) return

    setSubmitting(true)
    try {
      if (action.resetReferenceGuidanceBeforeRun) {
        if (!(await confirm(REANALYZE_REFERENCE_GUIDANCE_CONFIRM))) {
          return
        }

        await clearReferenceGuidance(project.path)
      }

      const pendingSyncWarning = buildPendingSyncWriteWarning(action.command, pendingMemorySyncMap)
      if (pendingSyncWarning && !(await confirm(buildPendingSyncWriteConfirm(pendingSyncWarning)))) {
        return
      }

      if (action.target) {
        navigate(buildWorkbenchTargetHref({ project, projectPath: project.path, target: action.target }))
      }

      await startAgentRun(
        createAgentRunRequest({
          threadId: agentThreadId,
          action: action.command,
          prompt: action.prompt ?? action.label,
          // 气泡只显示干净的动作标签（如「生成核心前提」），定位元信息仍随 prompt 发给 Agent。
          displayPrompt: action.label,
          origin: 'action',
          projectPath: project.path,
          selectedChapter: action.omitSelectedChapter ? undefined : selectedItem?.chapterNumber,
          target: action.target,
        }),
      )
    } catch (error) {
      console.error(error)
      toast.error('任务启动失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleComposerHandoffAction(action: WorkbenchAction) {
    if (activeRun || submitting) {
      toast.info('Agent 正在执行任务，请等待完成后再试')
      return
    }
    if (!project || !action.command) return
    const selectedChapter =
      action.selectedChapter ?? (action.omitSelectedChapter ? undefined : selectedItem?.chapterNumber)
    if (
      !(await allowAgentCommandWithDrafts({
        command: action.command,
        selectedChapter,
        warnWriteNext: false,
      }))
    ) {
      return
    }

    if (action.target) {
      navigate(buildWorkbenchTargetHref({ project, projectPath: project.path, target: action.target }))
    }

    requestComposerHandoff(
      {
        sourceActionId: action.id,
        command: action.command,
        prompt: '',
        adjust: action.adjust,
        target: action.target,
        selectedChapter,
      },
      agentThreadId,
    )
  }

  function handleSelectionHandoff(handoff: Omit<AgentComposerHandoff, 'id'>) {
    if (activeRun || submitting) {
      toast.info('Agent 正在执行任务，请等待完成后再试')
      return
    }
    if (!project) return

    requestComposerHandoff(handoff, agentThreadId)
  }

  async function handleEvaluatePremiseImpact(prompt: string) {
    if (activeRun || submitting) {
      toast.info('Agent 正在执行任务，请等待完成后再试')
      return
    }
    if (!project) return

    setSubmitting(true)
    try {
      await startAgentRun(
        createAgentRunRequest({
          threadId: agentThreadId,
          action: 'revise-premise',
          prompt,
          // 气泡显示干净标签；定位元信息（卡·字段/新旧值）已在 prompt 里发给 Agent。
          displayPrompt: '评估立项卡改动影响',
          origin: 'action',
          projectPath: project.path,
          target: { sectionId: 'settings', tabId: 'bible-premise', objectId: 'bible-premise' },
        }),
      )
    } catch (error) {
      console.error(error)
      toast.error('评估启动失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleEvaluateOutlineImpact(prompt: string) {
    if (activeRun || submitting) {
      toast.info('Agent 正在执行任务，请等待完成后再试')
      return
    }
    if (!project) return

    setSubmitting(true)
    try {
      await startAgentRun(
        createAgentRunRequest({
          threadId: agentThreadId,
          // 无 action → command 'freeform'：stakes_progression 无立项卡锚点，走独立评估通路。
          prompt,
          displayPrompt: '评估大纲改动影响',
          origin: 'action',
          // fresh freeform 默认走 direct chat（无引擎工具）；评估与落盘需要 NovelMemory MCP，显式声明引擎上下文。
          engineContext: true,
          projectPath: project.path,
        }),
      )
    } catch (error) {
      console.error(error)
      toast.error('评估启动失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleEvaluateManuscriptImpact({ prompt, chapter }: { prompt: string; chapter: number }) {
    if (activeRun || submitting) {
      toast.info('Agent 正在执行任务，请等待完成后再试')
      return
    }
    if (!project) return
    if (!(await allowAgentCommandWithDrafts({ command: 'sync-chapter-memory', selectedChapter: chapter }))) return

    setSubmitting(true)
    try {
      await startAgentRun(
        createAgentRunRequest({
          threadId: agentThreadId,
          action: 'sync-chapter-memory',
          prompt,
          displayPrompt: '同步本章记忆',
          origin: 'action',
          projectPath: project.path,
          selectedChapter: chapter,
          target: selectedItem
            ? { sectionId: 'blueprint', tabId: selectedItem.id, objectId: selectedItem.id }
            : undefined,
        }),
      )
    } catch (error) {
      console.error(error)
      toast.error('评估启动失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  function handleWorkbenchAction(action: WorkbenchAction) {
    if (action.kind === 'composer-handoff') {
      void handleComposerHandoffAction(action)
      return
    }

    if (action.kind === 'agent') {
      void handleAgentAction(action)
      return
    }

    handleClientAction(action)
  }

  function handleChapterViewChange(value: WorkbenchChapterView) {
    void confirmLeaveManuscriptEditor().then((leave) => {
      if (leave) onSelectedChapterViewChange?.(value)
    })
  }

  return (
    <main
      // 顶部 padding 平台感知（方案 A 上下分区）：win32 下舞台卡片从 caption 带（56px）下方
      // 开始，caption 按钮悬于 canvas gutter，不再压在 Agent 面板头部白底上（视觉混排根因）。
      // relative 是给 TitlebarDragGutter 的定位基准——那条 padding 不带 drag 属性，
      // 不补拖拽层则整条顶栏在 win32 上是死区（见组件注释）。
      className="relative h-full min-h-0 min-w-0 flex-1 pt-[max(0.75rem,var(--titlebar-gutter-top))] pb-3 pl-0 pr-3"
      data-workbench-stage="true"
      data-section-id={selectedSectionId}
      data-tab-id={activeTab?.id ?? undefined}
    >
      <div
        className="relative h-full min-h-0 w-full overflow-hidden"
      >
        <div
          className="grid h-full min-h-0"
          data-workbench-stage-grid="true"
          style={{
            gridTemplateColumns: isFullWidthSection
              ? WORKBENCH_STAGE_SINGLE_COLUMN_TEMPLATE
              : workbenchStageGridTemplateColumns(agentWidth),
            gridTemplateRows: WORKBENCH_GRID_TEMPLATE_ROWS,
          }}
        >
          <div
            className="min-h-0 min-w-0"
            data-workbench-stage-content-panel="true"
          >
            <div
              className={cn(WORKBENCH_STAGE_CARD_CLASS, 'h-full min-h-0 min-w-0 overflow-hidden')}
              data-workbench-content-card="true"
            >
              <div className="flex h-full min-h-0 flex-col">
                {selectedSectionId === 'status' ? (
                  <WorkbenchStatusPanel project={project} onAction={handleWorkbenchAction} />
                ) : selectedSectionId === 'chat' ? (
                  <CharacterChatBoard projectPath={project?.path ?? ''} />
                ) : selectedSectionId === 'packs' ? (
                  <CapabilityPackPanel projectPath={project?.path ?? ''} />
                ) : selectedSectionId === 'memory-graph' ? (
                  <MemoryGraphView projectPath={project?.path ?? ''} />
                ) : (
                  <WorkbenchContentView
                    agentThreadId={agentThreadId}
                    selectedSectionId={selectedSectionId}
                    selectedObjectId={selectedObjectId}
                    selectedTabId={selectedTabId}
                    emptyGuideAction={emptyGuideAction}
                    onEmptyGuideAction={handleWorkbenchAction}
                    onReferenceChanged={refreshProject}
                    onSelectionHandoff={handleSelectionHandoff}
                    onEvaluatePremiseImpact={handleEvaluatePremiseImpact}
                    onEvaluateOutlineImpact={handleEvaluateOutlineImpact}
                    onEvaluateManuscriptImpact={handleEvaluateManuscriptImpact}
                    selectionHandoffDisabled={isAgentBusy}
                    chapterView={chapterView}
                    onChapterViewChange={handleChapterViewChange}
                    titlebarActions={titlebarActions}
                    onTitlebarAction={handleWorkbenchAction}
                  />
                )}
              </div>
            </div>
          </div>

          {isFullWidthSection ? null : (
            <>
              <div
                className={WORKBENCH_RESIZE_HANDLE_CLASS}
                data-workbench-agent-resize-handle="true"
                aria-label="调整 Agent 面板宽度"
                role="separator"
                tabIndex={0}
                onPointerDown={onAgentResizeStart}
                style={{ justifySelf: 'center' }}
              >
                <span
                  aria-hidden="true"
                  className={WORKBENCH_RESIZE_HANDLE_LINE_CLASS}
                />
              </div>

              <div
                className="min-h-0 min-w-0"
                data-workbench-agent-panel="true"
              >
                <div
                  className={cn(WORKBENCH_STAGE_CARD_CLASS, 'h-full min-h-0 min-w-0 overflow-hidden')}
                  data-agent-panel-column="true"
                >
                  <AgentPanel threadId={agentThreadId} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      {confirmDialog}
      <TitlebarDragGutter />
    </main>
  )
}
