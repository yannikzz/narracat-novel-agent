import type { AgentRun } from '@shared/types/agent'
import type { NovelProjectDetail, NovelWorkbenchTreeItem } from '@shared/types/novel'
import type { WorkbenchPrimarySectionId, WorkbenchTabItem } from './workbench-navigation'

/**
 * Agent 已发问、正在等作者回答时携带的问题指针。
 * questionRequestId 交给 agent-store 的 focusQuestionRequest，由 AgentThreadView 滚到对应问题卡。
 */
export interface WorkbenchPendingQuestion {
  questionRequestId: string
  /** 第一条未回答问题的正文，作内容区引导语；同批后续问题在右侧问题卡里翻页回答。 */
  prompt: string
}

export interface WorkbenchGenerationState {
  /**
   * running=机器在跑；waiting-user=Agent 已发问、活儿停在作者这边。
   * 两态都要占住内容区：waiting-user 若退回空态，作者会以为「点了没反应」，
   * 而 Agent 正在右侧干等（全 App 只剩左下角铃铛一个红点）。
   */
  phase: 'running' | 'waiting-user'
  label: string
  statusText: string
  pendingQuestion?: WorkbenchPendingQuestion
}

export type WorkbenchSidebarGenerationTarget = { phase: 'running' | 'waiting-user' } & (
  | { kind: 'primary'; id: WorkbenchPrimarySectionId }
  | { kind: 'volume'; id: string }
  | { kind: 'chapter'; id: string }
)

/** 内容区/侧边栏要占住的 run 状态：跑着算，停下来等作者回答同样算。 */
function isWorkbenchOccupyingRun(run: AgentRun | null): run is AgentRun {
  if (!run) return false
  return run.status === 'running' || run.status === 'waiting-user'
}

export function resolveWorkbenchGenerationState({
  activeRun,
  activeTab,
  pendingQuestion,
  selectedItem,
  selectedSectionId,
}: {
  activeRun: AgentRun | null
  activeTab: WorkbenchTabItem | null
  pendingQuestion?: WorkbenchPendingQuestion | null
  selectedItem: NovelWorkbenchTreeItem | null
  selectedSectionId: WorkbenchPrimarySectionId
}): WorkbenchGenerationState | null {
  if (!isWorkbenchOccupyingRun(activeRun) || !activeRun.target || !selectedItem) return null

  const target = activeRun.target
  if (target.sectionId !== selectedSectionId) return null
  if (target.objectId !== selectedItem.id) return null
  if (activeTab && target.tabId !== activeTab.id && target.tabId !== activeTab.objectId) return null

  const label = activeTab?.title ?? selectedItem.title
  if (activeRun.status === 'waiting-user') {
    // 问题指针可能暂缺（question part 尚未落到本线程）：仍占住内容区并如实说在等回答，
    // 只是少一个直达按钮，好过退回空态假装无事发生。
    return {
      phase: 'waiting-user',
      label,
      statusText: 'NarraCat 在等你回答',
      ...(pendingQuestion ? { pendingQuestion } : {}),
    }
  }

  return {
    phase: 'running',
    label,
    statusText: `正在生成${label}`,
  }
}

export function resolveWorkbenchSidebarGenerationTarget({
  activeRun,
  project,
}: {
  activeRun: AgentRun | null
  project: NovelProjectDetail | null
}): WorkbenchSidebarGenerationTarget | null {
  if (!isWorkbenchOccupyingRun(activeRun) || !activeRun.target || !project) return null
  if (activeRun.projectPath && activeRun.projectPath !== project.path) return null

  const sectionId = readGenerationSectionId(activeRun.target.sectionId)
  if (!sectionId) return null

  // 与内容区同源：等作者回答时活儿没结束，标记不能消失，否则左右两处状态自相矛盾。
  const phase = activeRun.status === 'waiting-user' ? ('waiting-user' as const) : ('running' as const)

  const targetItem = project.treeItems.find(
    (item) => item.id === activeRun.target?.objectId || item.id === activeRun.target?.tabId,
  )
  const targetTocItem = project.tocItems.find(
    (item) => item.id === activeRun.target?.objectId || item.id === activeRun.target?.tabId,
  )

  if (targetItem?.kind === 'chapter' || targetTocItem?.kind === 'chapter') {
    return { phase, kind: 'chapter', id: targetItem?.id ?? targetTocItem?.id ?? activeRun.target.objectId }
  }

  if (targetItem?.kind === 'volume' || targetTocItem?.kind === 'volume') {
    return { phase, kind: 'volume', id: targetItem?.id ?? targetTocItem?.id ?? activeRun.target.objectId }
  }

  if (targetItem?.kind === 'volume-outline') {
    const volumeId =
      targetItem.parentId ??
      project.tocItems.find((item) => item.kind === 'volume' && item.volumeNumber === targetItem.volumeNumber)?.id
    if (volumeId) return { phase, kind: 'volume', id: volumeId }
  }

  return { phase, kind: 'primary', id: sectionId }
}

function readGenerationSectionId(value: string): WorkbenchPrimarySectionId | null {
  if (value === 'blueprint' || value === 'settings' || value === 'reference-works') return value
  return null
}
