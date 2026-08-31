import { WorkbenchObjectView } from './WorkbenchObjectView'
import { useAgentStore } from '@/lib/agent-store'
import { getPendingAgentQuestion } from '@/lib/agent-panel'
import { useNovelStore } from '@/lib/novel-store'
import type { WorkbenchAction } from '@/lib/workbench-actions'
import { resolveCurrentStageChapterId } from '@/lib/workbench-chapter-state'
import { resolveWorkbenchGenerationState } from '@/lib/workbench-generation'
import { findWorkbenchTab, getWorkbenchTabs } from '@/lib/workbench-navigation'
import type { WorkbenchPrimarySectionId } from '@/lib/workbench-navigation'
import type { AgentComposerHandoff } from '@/types/agent'
import type { NovelProjectDetail, NovelWorkbenchArtifacts, NovelWorkbenchTreeItem } from '@shared/types/novel'
import type { WorkbenchChapterView } from '@shared/types/workbench'

function workbenchSectionTitle(sectionId: WorkbenchPrimarySectionId): string {
  if (sectionId === 'reference-works') return '参考作品'
  return sectionId === 'settings' ? '设定集' : '小说大纲'
}

export function selectWorkbenchObjectItem({
  project,
  selectedObjectId,
}: {
  project: NovelProjectDetail | null
  selectedObjectId: string | null
}): NovelWorkbenchTreeItem | null {
  if (!project || !selectedObjectId) return null

  return project.treeItems.find((item) => item.id === selectedObjectId) ?? null
}

export function selectMatchingWorkbenchArtifacts({
  activeWorkbenchArtifacts,
  selectedItem,
}: {
  activeWorkbenchArtifacts: NovelWorkbenchArtifacts | null
  selectedItem: NovelWorkbenchTreeItem | null
}): NovelWorkbenchArtifacts | null {
  return activeWorkbenchArtifacts?.objectId === selectedItem?.id ? activeWorkbenchArtifacts : null
}

export function resolveWorkbenchContentSelection({
  activeWorkbenchArtifacts,
  project,
  selectedSectionId,
  selectedObjectId,
  selectedTabId,
}: {
  activeWorkbenchArtifacts: NovelWorkbenchArtifacts | null
  project: NovelProjectDetail | null
  selectedSectionId: WorkbenchPrimarySectionId
  selectedObjectId?: string | null
  selectedTabId: string | null
}) {
  const tabs = project ? getWorkbenchTabs(project, selectedSectionId) : []
  const normalizedTabId = selectedTabId?.trim() || null
  const exactTab = normalizedTabId
    ? tabs.find((tab) => tab.id === normalizedTabId || tab.objectId === normalizedTabId)
    : null
  const resolvedTab = exactTab ?? findWorkbenchTab(tabs, normalizedTabId)
  const legacyItem =
    selectedObjectId && !exactTab
      ? selectWorkbenchObjectItem({
          project,
          selectedObjectId,
        })
      : null
  const activeTab = legacyItem ? null : resolvedTab
  const selectedItem = selectWorkbenchObjectItem({
    project,
    selectedObjectId: legacyItem?.id ?? resolvedTab?.objectId ?? null,
  })
  const artifacts = selectMatchingWorkbenchArtifacts({ activeWorkbenchArtifacts, selectedItem })

  return { activeTab, artifacts, selectedItem, tabs }
}

export function WorkbenchContentView({
  agentThreadId,
  chapterView,
  emptyGuideAction,
  onChapterViewChange,
  onEmptyGuideAction,
  onEvaluateManuscriptImpact,
  onEvaluateOutlineImpact,
  onEvaluatePremiseImpact,
  onReferenceChanged,
  onSelectionHandoff,
  onTitlebarAction,
  selectedSectionId,
  selectedObjectId,
  selectedTabId,
  selectionHandoffDisabled,
  titlebarActions = [],
}: {
  agentThreadId?: string
  chapterView: WorkbenchChapterView
  emptyGuideAction?: WorkbenchAction | null
  onChapterViewChange: (value: WorkbenchChapterView) => void
  onEmptyGuideAction?: (action: WorkbenchAction) => void
  onEvaluateManuscriptImpact?: (input: { prompt: string; chapter: number }) => void
  onEvaluateOutlineImpact?: (prompt: string) => void
  onEvaluatePremiseImpact?: (prompt: string) => void
  onReferenceChanged?: () => void
  onSelectionHandoff?: (handoff: Omit<AgentComposerHandoff, 'id'>) => void
  onTitlebarAction?: (action: WorkbenchAction) => void
  selectedSectionId: WorkbenchPrimarySectionId
  selectedObjectId?: string | null
  selectedTabId: string | null
  selectionHandoffDisabled?: boolean
  titlebarActions?: WorkbenchAction[]
}) {
  const project = useNovelStore((state) => state.activeProject)
  const activeWorkbenchArtifacts = useNovelStore((state) => state.activeWorkbenchArtifacts)
  const loading = useNovelStore((state) => state.loading)
  const activeThreadId = useAgentStore((state) => state.activeThreadId)
  const scopedThreadId = agentThreadId ?? activeThreadId
  const activeRun = useAgentStore((state) => state.threadsById[scopedThreadId]?.activeRun ?? null)
  // selector 只取线程引用，派生对象在组件里算：selector 每次返回新对象会让 useSyncExternalStore 快照恒变。
  const scopedThread = useAgentStore((state) => state.threadsById[scopedThreadId])
  const focusQuestionRequest = useAgentStore((state) => state.focusQuestionRequest)
  const pendingQuestion = getPendingAgentQuestion(scopedThread)
  const { activeTab, artifacts, selectedItem, tabs } = resolveWorkbenchContentSelection({
    activeWorkbenchArtifacts,
    project,
    selectedSectionId,
    selectedObjectId,
    selectedTabId,
  })
  const currentChapterId = project ? resolveCurrentStageChapterId(project.tocItems) : null
  const generationState = resolveWorkbenchGenerationState({
    activeRun,
    activeTab,
    pendingQuestion,
    selectedItem,
    selectedSectionId,
  })

  return (
    <WorkbenchObjectView
      sectionId={selectedSectionId}
      sectionTitle={workbenchSectionTitle(selectedSectionId)}
      projectPath={project?.path ?? ''}
      tabs={tabs}
      activeTab={activeTab}
      activeTabId={activeTab?.id ?? null}
      selectedItem={selectedItem}
      artifacts={artifacts}
      currentChapterId={currentChapterId}
      tocItems={project?.tocItems ?? []}
      chapterView={chapterView}
      emptyGuideAction={emptyGuideAction}
      generationState={generationState}
      loading={loading}
      onAnswerPendingQuestion={(questionRequestId) => focusQuestionRequest(questionRequestId, scopedThreadId)}
      onChapterViewChange={onChapterViewChange}
      onEmptyGuideAction={onEmptyGuideAction}
      onReferenceChanged={onReferenceChanged}
      onSelectionHandoff={onSelectionHandoff}
      onEvaluatePremiseImpact={onEvaluatePremiseImpact}
      onEvaluateOutlineImpact={onEvaluateOutlineImpact}
      onEvaluateManuscriptImpact={onEvaluateManuscriptImpact}
      titlebarActions={titlebarActions}
      onTitlebarAction={onTitlebarAction}
      selectionHandoffDisabled={selectionHandoffDisabled || Boolean(activeRun)}
    />
  )
}
