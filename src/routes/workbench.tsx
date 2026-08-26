import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { AlertCircle, FolderOpen, Loader2, type LucideIcon } from 'lucide-react'
import { LoadRecoveryNotice } from '@/components/LoadRecoveryNotice'
import { WorkbenchPrimarySidebar } from '@/components/workbench/WorkbenchPrimarySidebar'
import { WorkbenchStage } from '@/components/workbench/WorkbenchStage'
import {
  APP_CANVAS_CLASS,
  WORKBENCH_RESIZE_HANDLE_CLASS,
  WORKBENCH_RESIZE_HANDLE_LINE_CLASS,
  WORKSPACE_STATE_CLASS,
} from '@/design-system'
import { getAgentThreadIdForProject, useAgentStore } from '@/lib/agent-store'
import { writeWorkLocation } from '@/lib/ipc'
import { createLoadIssue } from '@/lib/load-state'
import { hydrateAgentThread } from '@/lib/use-agent-events'
import { useNovelStore } from '@/lib/novel-store'
import { loadWorkbenchProject, useWorkbenchProject } from '@/lib/use-novel-project'
import {
  clampWorkbenchPanelLayout,
  createWorkbenchPanelDragSession,
  defaultWorkbenchPanelLayout,
  workbenchPanelGridTemplates,
  WORKBENCH_GRID_TEMPLATE_ROWS,
  WORKBENCH_LAYOUT_STORAGE_KEY,
  type WorkbenchPanelLayout,
  WORKBENCH_STAGE_SINGLE_COLUMN_TEMPLATE,
  isFullWidthWorkbenchSection,
} from '@/lib/workbench-layout'
import { getWorkbenchTabs } from '@/lib/workbench-navigation'
import type { WorkbenchPrimarySectionId } from '@/lib/workbench-navigation'
import { resolveDefaultChapterView } from '@/lib/workbench-chapter-state'
import {
  readWorkbenchChapterView,
  readWorkbenchObjectId,
  readWorkbenchSectionId,
  readWorkbenchTabId,
} from '@/lib/workbench-selection'
import { createWorkbenchLocation } from '@/lib/work-location'
import type { NovelProjectDetail } from '@shared/types/novel'

function WorkbenchRouteState({
  children,
  icon: Icon,
  title,
}: {
  children: ReactNode
  icon: LucideIcon
  title: string
}) {
  return (
    // 顶部 padding 平台感知：win32 下让状态卡也从 caption 带下方开始（方案 A 上下分区）。
    <main className="h-full min-h-0 min-w-0 flex-1 p-3 pt-[max(0px,var(--titlebar-gutter-top))]">
      <div className={`${WORKSPACE_STATE_CLASS} flex h-full min-h-0 items-center justify-center p-6`}>
        <div className="max-w-sm text-center">
          <Icon className="mx-auto mb-3 size-5 text-hint-foreground" />
          <div className="text-sm font-medium text-foreground">{title}</div>
          <div className="mt-1 text-xs leading-snug text-muted-foreground">{children}</div>
        </div>
      </div>
    </main>
  )
}

function sectionForTab(
  fallbackSectionId: WorkbenchPrimarySectionId,
  tabId: string | null,
  project: NovelProjectDetail | null,
): WorkbenchPrimarySectionId {
  if (!project || !tabId) return fallbackSectionId

  const sectionIds: WorkbenchPrimarySectionId[] = ['reference-works', 'blueprint', 'settings']
  return (
    sectionIds.find((sectionId) =>
      getWorkbenchTabs(project, sectionId).some((tab) => tab.id === tabId || tab.objectId === tabId),
    ) ?? fallbackSectionId
  )
}

function readStoredWorkbenchPanelLayout(): WorkbenchPanelLayout {
  if (typeof window === 'undefined') return defaultWorkbenchPanelLayout()

  try {
    const raw = window.localStorage.getItem(WORKBENCH_LAYOUT_STORAGE_KEY)
    if (!raw) return defaultWorkbenchPanelLayout()
    const parsed = JSON.parse(raw) as Partial<WorkbenchPanelLayout>
    return {
      sidebar: typeof parsed.sidebar === 'number' ? parsed.sidebar : defaultWorkbenchPanelLayout().sidebar,
      agent: typeof parsed.agent === 'number' ? parsed.agent : defaultWorkbenchPanelLayout().agent,
    }
  } catch {
    return defaultWorkbenchPanelLayout()
  }
}

function areWorkbenchPanelLayoutsEqual(left: WorkbenchPanelLayout, right: WorkbenchPanelLayout): boolean {
  return left.sidebar === right.sidebar && left.agent === right.agent
}

function applyWorkbenchPanelLayoutToDom(container: HTMLElement, layout: WorkbenchPanelLayout) {
  const templates = workbenchPanelGridTemplates(layout)
  container.style.gridTemplateColumns = templates.workbench
  container.style.gridTemplateRows = WORKBENCH_GRID_TEMPLATE_ROWS

  const stageGrid = container.querySelector<HTMLElement>('[data-workbench-stage-grid="true"]')
  if (stageGrid) {
    const stage = stageGrid.closest<HTMLElement>('[data-workbench-stage="true"]')
    const fullWidthSection = isFullWidthWorkbenchSection(stage?.dataset.sectionId)
    stageGrid.style.gridTemplateColumns = fullWidthSection ? WORKBENCH_STAGE_SINGLE_COLUMN_TEMPLATE : templates.stage
    stageGrid.style.gridTemplateRows = WORKBENCH_GRID_TEMPLATE_ROWS
  }
}

function useWorkbenchPanelLayout() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<WorkbenchPanelLayout>(() => readStoredWorkbenchPanelLayout())
  const layoutRef = useRef<WorkbenchPanelLayout>(layout)

  useEffect(() => {
    layoutRef.current = layout
    const container = containerRef.current
    if (container) applyWorkbenchPanelLayoutToDom(container, layout)
    window.localStorage.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
  }, [layout])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const syncContainerWidth = () => {
      const nextLayout = clampWorkbenchPanelLayout(layoutRef.current, container.getBoundingClientRect().width)
      layoutRef.current = nextLayout
      applyWorkbenchPanelLayoutToDom(container, nextLayout)
      setLayout((current) => (areWorkbenchPanelLayoutsEqual(current, nextLayout) ? current : nextLayout))
    }

    syncContainerWidth()
    const observer = new ResizeObserver(syncContainerWidth)
    observer.observe(container)

    return () => observer.disconnect()
  }, [])

  const startResize = useCallback((edge: 'sidebar' | 'agent', event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()

    const container = containerRef.current
    if (!container) return

    const startX = event.clientX
    const startLayout = layoutRef.current
    const containerWidth = container.getBoundingClientRect().width
    const handle = event.currentTarget

    try {
      handle.setPointerCapture(event.pointerId)
    } catch {
      // Window-level listeners below keep resize active if pointer capture is unavailable.
    }

    const dragSession = createWorkbenchPanelDragSession({
      edge,
      startX,
      startLayout,
      containerWidth,
      applyLayout: (nextLayout) => {
        layoutRef.current = nextLayout
        applyWorkbenchPanelLayoutToDom(container, nextLayout)
      },
      commitLayout: (nextLayout) => {
        layoutRef.current = nextLayout
        setLayout((current) => (areWorkbenchPanelLayoutsEqual(current, nextLayout) ? current : nextLayout))
      },
    })

    const previousCursor = document.documentElement.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.documentElement.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    container.dataset.workbenchResizing = edge

    const cleanup = () => {
      try {
        handle.releasePointerCapture(event.pointerId)
      } catch {
        // Ignore release failures for pointers that already ended outside the handle.
      }

      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      document.documentElement.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      delete container.dataset.workbenchResizing
    }

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      dragSession.move(moveEvent.clientX)
    }

    const handlePointerUp = () => {
      dragSession.end()
      cleanup()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp, { once: true })
    window.addEventListener('pointercancel', handlePointerUp, { once: true })
  }, [])

  return {
    containerRef,
    layout,
    startAgentResize: (event: PointerEvent<HTMLDivElement>) => startResize('agent', event),
    startSidebarResize: (event: PointerEvent<HTMLDivElement>) => startResize('sidebar', event),
  }
}

export function WorkbenchRoute() {
  const [searchParams, setSearchParams] = useSearchParams()
  const projectPath = searchParams.get('project')
  const routeSectionId = useMemo(() => readWorkbenchSectionId(searchParams), [searchParams])
  const hasSectionParam = Boolean(searchParams.get('section')?.trim())
  const hasTabParam = Boolean(searchParams.get('tab')?.trim())
  const selectedTabId = useMemo(() => readWorkbenchTabId(searchParams), [searchParams])
  const selectedObjectId = useMemo(() => readWorkbenchObjectId(searchParams), [searchParams])
  const selectedChapterView = useMemo(() => readWorkbenchChapterView(searchParams), [searchParams])
  const selectedChapter = useMemo(() => {
    const raw = searchParams.get('chapter')
    if (!raw) return undefined

    const parsed = Number(raw)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }, [searchParams])
  const activeProject = useNovelStore((state) => state.activeProject)
  const activeWorkbenchArtifacts = useNovelStore((state) => state.activeWorkbenchArtifacts)
  const loading = useNovelStore((state) => state.loading)
  const workbenchLoad = useNovelStore((state) => state.workbenchLoad)
  const error = workbenchLoad.status === 'error' ? workbenchLoad.issue?.summary ?? null : null
  const fallbackThreadId = useAgentStore((state) => state.activeThreadId)
  const selectProjectThread = useAgentStore((state) => state.selectProjectThread)
  const currentProject = activeProject?.path === projectPath ? activeProject : null
  const loadedTreeItem =
    currentProject && activeWorkbenchArtifacts?.projectPath === currentProject.path
      ? currentProject.treeItems.find((item) => item.id === activeWorkbenchArtifacts.objectId) ?? null
      : null
  const resolvedChapterView =
    loadedTreeItem?.kind === 'chapter'
      ? (selectedChapterView ?? resolveDefaultChapterView(loadedTreeItem))
      : undefined
  const agentThreadId = currentProject ? getAgentThreadIdForProject(currentProject) : fallbackThreadId
  // 首次进入工作台（无 section / tab / object 参数）默认落在「状态」总览页，不再自动跳到当前写作章节。
  const isDefaultEntry = !hasSectionParam && !hasTabParam && !selectedObjectId
  const selectedSectionId = useMemo(
    () => {
      if (hasSectionParam) return routeSectionId
      if (isDefaultEntry) return 'status'

      return sectionForTab(routeSectionId, selectedTabId, currentProject)
    },
    [currentProject, hasSectionParam, isDefaultEntry, routeSectionId, selectedTabId],
  )
  const sectionIdForLoading = hasSectionParam || hasTabParam ? selectedSectionId : undefined
  const selectedObjectIdForView = hasSectionParam || hasTabParam ? null : selectedObjectId
  const activeRun = useAgentStore((state) => state.threadsById[agentThreadId]?.activeRun ?? null)
  const { containerRef, layout, startAgentResize, startSidebarResize } = useWorkbenchPanelLayout()
  const gridTemplates = useMemo(() => workbenchPanelGridTemplates(layout), [layout])

  useWorkbenchProject(projectPath, selectedChapter, selectedObjectId ?? undefined, sectionIdForLoading, selectedTabId)

  useEffect(() => {
    if (!currentProject) return
    selectProjectThread(currentProject)
    void hydrateAgentThread(getAgentThreadIdForProject(currentProject)).catch((error) => console.error(error))
  }, [currentProject?.id, currentProject?.path, selectProjectThread])

  useEffect(() => {
    if (!currentProject || !workbenchLoad.hasData) return
    void writeWorkLocation(
      createWorkbenchLocation({
        project: currentProject,
        searchParams,
        sectionId: selectedSectionId,
        chapterView: resolvedChapterView,
      }),
    ).catch((error) => {
      createLoadIssue('startup', error)
    })
  }, [
    currentProject,
    searchParams,
    selectedChapterView,
    selectedObjectId,
    selectedSectionId,
    resolvedChapterView,
    workbenchLoad.hasData,
  ])

  function retryWorkbenchLoad() {
    if (!projectPath) return
    void loadWorkbenchProject(
      projectPath,
      selectedChapter,
      selectedObjectId ?? undefined,
      sectionIdForLoading,
      selectedTabId,
      { smooth: workbenchLoad.hasData },
    )
  }

  function handleChapterViewChange(view: NonNullable<typeof selectedChapterView>) {
    const next = new URLSearchParams(searchParams)
    next.set('view', view)
    setSearchParams(next, { replace: true })
  }

  const stage =
    error ? (
      <WorkbenchRouteState icon={AlertCircle} title="项目读取失败">
        {workbenchLoad.issue ? (
          <LoadRecoveryNotice
            className="mt-3 text-left"
            from={`/workbench?${searchParams.toString()}`}
            issue={workbenchLoad.issue}
            onRetry={retryWorkbenchLoad}
            retrying={loading}
          />
        ) : null}
      </WorkbenchRouteState>
    ) : !projectPath ? (
      <WorkbenchRouteState icon={FolderOpen} title="未选择小说项目">
        请从图书馆选择一个 NarraCat 项目。
      </WorkbenchRouteState>
    ) : loading && !currentProject ? (
      <WorkbenchRouteState icon={Loader2} title="正在读取小说">
        正在加载项目目录和章节产物。
      </WorkbenchRouteState>
    ) : currentProject ? (
      <WorkbenchStage
        selectedChapterView={resolvedChapterView}
        selectedSectionId={selectedSectionId}
        selectedTabId={selectedTabId}
        selectedObjectId={selectedObjectIdForView}
        agentWidth={layout.agent}
        onAgentResizeStart={startAgentResize}
        onSelectedChapterViewChange={handleChapterViewChange}
      />
    ) : (
      <WorkbenchRouteState icon={FolderOpen} title="没有项目数据">
        当前路径没有可显示的 NarraCat 项目数据。
      </WorkbenchRouteState>
    )

  return (
    <div
      ref={containerRef}
      className={`${APP_CANVAS_CLASS} grid h-full min-h-0 overflow-hidden`}
      data-workbench-layout-grid="true"
      style={{
        gridTemplateColumns: gridTemplates.workbench,
        gridTemplateRows: WORKBENCH_GRID_TEMPLATE_ROWS,
      }}
    >
      <div
        className="min-h-0 min-w-0 overflow-hidden"
        data-workbench-sidebar-panel="true"
      >
        <WorkbenchPrimarySidebar
          activeRun={activeRun}
          error={error}
          hasProjectPath={Boolean(projectPath)}
          loading={loading}
          project={currentProject}
          selectedSectionId={selectedSectionId}
          selectedObjectId={selectedObjectIdForView}
        />
      </div>
      <div
        className={WORKBENCH_RESIZE_HANDLE_CLASS}
        data-workbench-sidebar-resize-handle="true"
        aria-label="调整侧边栏宽度"
        role="separator"
        tabIndex={0}
        onPointerDown={startSidebarResize}
      >
        <span
          aria-hidden="true"
          className={WORKBENCH_RESIZE_HANDLE_LINE_CLASS}
        />
      </div>
      <div
        className="relative min-h-0 min-w-0 overflow-hidden"
        data-workbench-content-panel="true"
      >
        {stage}
        {/* stale 横幅横跨整个舞台（含 Agent 栏）。方案 A 后横幅整体在 caption 带下方
            （top 消费 --titlebar-gutter-top），右缘不再需要 --titlebar-inset-right 让位。 */}
        {workbenchLoad.status === 'stale' && workbenchLoad.issue ? (
          <LoadRecoveryNotice
            className="absolute left-4 right-4 top-[max(1rem,calc(var(--titlebar-gutter-top)+0.25rem))] z-30 shadow-[var(--shadow-floating)]"
            compact
            from={`/workbench?${searchParams.toString()}`}
            issue={workbenchLoad.issue}
            onRetry={retryWorkbenchLoad}
            retrying={loading}
            stale
          />
        ) : null}
      </div>
    </div>
  )
}
