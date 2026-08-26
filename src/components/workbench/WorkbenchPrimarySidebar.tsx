import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'framer-motion'
import {
  BookOpen,
  BookMarked,
  ChevronRight,
  Folder,
  Gauge,
  House,
  ListChevronsUpDown,
  ListCollapse,
  Loader2,
  MessagesSquare,
  NotebookTabs,
  Package,
  Settings,
  Waypoints,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { GlobalNotificationBell } from '@/components/notifications/GlobalNotificationBell'
import { UpdateReadyBanner } from '@/components/settings/UpdateReadyBanner'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SIDEBAR_ROW_CLASS, WARNING_PILL_CLASS } from '@/design-system'
import { useAgentStore } from '@/lib/agent-store'
import { cn } from '@/lib/cn'
import { confirmLeaveManuscriptEditor, useManuscriptEditorGuard } from '@/lib/manuscript-editor-guard'
import { useManuscriptDrafts } from '@/lib/use-manuscript-drafts'
import { usePendingMemorySyncMap } from '@/lib/use-pending-memory-sync'
import { usePlannedStateCounts } from '@/lib/use-planned-state-counts'
import { usePlannedStateRefresh } from '@/lib/planned-state-refresh'
import {
  resolveChapterDirectoryTag,
  resolveCurrentStageChapterId,
  resolveCurrentStageVolumeTag,
} from '@/lib/workbench-chapter-state'
import {
  resolveWorkbenchSidebarGenerationTarget,
  type WorkbenchSidebarGenerationTarget,
} from '@/lib/workbench-generation'
import { buildPrimarySectionHref, getWorkbenchPrimarySections } from '@/lib/workbench-navigation'
import type { WorkbenchPrimarySectionId } from '@/lib/workbench-navigation'
import { buildWorkbenchObjectHref } from '@/lib/workbench-selection'
import type { AgentRun } from '@shared/types/agent'
import type { NovelProjectDetail, NovelTocItem } from '@shared/types/novel'

type WorkbenchChapterDirectoryVolumeGroup = {
  volume: NovelTocItem
  chapters: NovelTocItem[]
}

function projectTitle(project: NovelProjectDetail | null, loading: boolean, error: string | null, hasProjectPath: boolean): string {
  if (project) return project.title
  if (error) return '项目读取失败'
  if (!hasProjectPath) return '未选择小说'
  if (loading) return '正在加载小说'
  return '没有项目数据'
}

function projectSubtitle(project: NovelProjectDetail | null, loading: boolean, error: string | null, hasProjectPath: boolean): string {
  if (project) return `${project.chapterProgress} · ${project.wordCountLabel}`
  if (error) return error
  if (!hasProjectPath) return '从图书馆选择'
  if (loading) return '读取中...'
  return '无可显示数据'
}

export function createWorkbenchChapterDirectoryGroups(tocItems: NovelTocItem[]): WorkbenchChapterDirectoryVolumeGroup[] {
  const groups: WorkbenchChapterDirectoryVolumeGroup[] = []

  for (const item of tocItems) {
    if (item.kind === 'volume') {
      groups.push({ volume: item, chapters: [] })
      continue
    }

    if (item.kind === 'chapter') {
      const currentGroup = groups.at(-1)
      if (currentGroup) currentGroup.chapters.push(item)
    }
  }

  return groups
}

export function findChapterVolumeId(
  groups: WorkbenchChapterDirectoryVolumeGroup[],
  chapterId: string | null | undefined,
): string | null {
  if (!chapterId) return null

  for (const group of groups) {
    if (group.chapters.some((chapter) => chapter.id === chapterId)) return group.volume.id
  }

  return null
}

export function createInitialCollapsedVolumeIds({
  visibleVolumeId,
  volumeIds,
}: {
  visibleVolumeId: string | null
  volumeIds: string[]
}): ReadonlySet<string> {
  return new Set(volumeIds.filter((volumeId) => volumeId !== visibleVolumeId))
}

function WorkbenchChapterDirectory({
  generationTarget,
  project,
  selectedObjectId,
}: {
  generationTarget: WorkbenchSidebarGenerationTarget | null
  project: NovelProjectDetail
  selectedObjectId?: string | null
}) {
  const chaptersByVolume = useMemo(() => createWorkbenchChapterDirectoryGroups(project.tocItems), [project.tocItems])
  const currentChapterId = useMemo(() => resolveCurrentStageChapterId(project.tocItems), [project.tocItems])
  const activeRunFlag = useAgentStore((state) => Boolean(state.threadsById[state.activeThreadId]?.activeRun))
  const saveVersion = useManuscriptEditorGuard((state) => state.saveVersion)
  const draftVersion = useManuscriptEditorGuard((state) => state.draftVersion)
  const plannedStateVersion = usePlannedStateRefresh((state) => state.version)
  const pendingMap = usePendingMemorySyncMap(project.path, `${activeRunFlag}:${saveVersion}`)
  const manuscriptDrafts = useManuscriptDrafts(project.path, draftVersion)
  const manuscriptDraftChapters = useMemo(
    () => new Set(manuscriptDrafts.map((draft) => draft.chapter)),
    [manuscriptDrafts],
  )
  const plannedStateCounts = usePlannedStateCounts(project.path, `${activeRunFlag}:${saveVersion}:${plannedStateVersion}`)
  const selectedVolumeId = findChapterVolumeId(chaptersByVolume, selectedObjectId)
  const currentStageVolumeId = findChapterVolumeId(chaptersByVolume, currentChapterId)
  const volumeIds = useMemo(() => chaptersByVolume.map((group) => group.volume.id), [chaptersByVolume])
  const [collapsedVolumeIds, setCollapsedVolumeIds] = useState<ReadonlySet<string>>(() =>
    createInitialCollapsedVolumeIds({
      visibleVolumeId: selectedVolumeId ?? currentStageVolumeId,
      volumeIds,
    }),
  )
  const navigate = useNavigate()

  useEffect(() => {
    if (!selectedVolumeId) return

    setCollapsedVolumeIds((current) => {
      if (!current.has(selectedVolumeId)) return current

      const next = new Set(current)
      next.delete(selectedVolumeId)
      return next
    })
  }, [selectedObjectId, selectedVolumeId])

  if (!chaptersByVolume.some((group) => group.chapters.length > 0)) return null
  const allCollapsed = volumeIds.every((volumeId) => collapsedVolumeIds.has(volumeId))
  const DirectoryToggleIcon = allCollapsed ? ListChevronsUpDown : ListCollapse
  const directoryToggleLabel = allCollapsed ? '全部展开小说目录' : '全部收起小说目录'

  function toggleVolume(volumeId: string) {
    setCollapsedVolumeIds((current) => {
      const next = new Set(current)
      if (next.has(volumeId)) {
        next.delete(volumeId)
      } else {
        next.add(volumeId)
      }
      return next
    })
  }

  function toggleAllVolumes() {
    setCollapsedVolumeIds(allCollapsed ? new Set() : new Set(volumeIds))
  }

  function handleGuardedNavigation(event: MouseEvent<HTMLAnchorElement>, href: string) {
    if (!useManuscriptEditorGuard.getState().dirty) return
    event.preventDefault()
    void confirmLeaveManuscriptEditor().then((leave) => {
      if (leave) navigate(href)
    })
  }

  return (
    <section
      className="mt-1 min-h-0 flex-1 overflow-hidden border-t border-border pt-4"
      data-workbench-chapter-directory="true"
    >
      <ScrollArea className="h-full min-h-0" data-workbench-chapter-directory-scroll="true">
        <div className="pb-4 pl-2 pr-1">
          <div
            className="group mb-2 flex h-8 items-center justify-between gap-2 px-2"
            data-workbench-chapter-directory-title="true"
          >
            <span className="text-sm font-medium text-hint-foreground">小说目录</span>
            <IconTooltip label={directoryToggleLabel} side="right">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={directoryToggleLabel}
                data-workbench-chapter-directory-toggle={allCollapsed ? 'expand-all' : 'collapse-all'}
                className="
                  opacity-0 transition-opacity duration-150
                  group-hover:opacity-100 focus-visible:opacity-100
                "
                onClick={toggleAllVolumes}
              >
                <DirectoryToggleIcon className="size-3.5" />
              </Button>
            </IconTooltip>
          </div>
          <nav aria-label="小说章节目录" className="space-y-1">
            {chaptersByVolume.map((group) => {
              const expanded = !collapsedVolumeIds.has(group.volume.id)
              const chapterListId = `workbench-chapter-list-${group.volume.id}`
              const volumeTag = resolveCurrentStageVolumeTag({
                chapters: group.chapters,
                currentChapterId,
                expanded,
              })
              const generatingChapter =
                generationTarget?.kind === 'chapter'
                  ? group.chapters.find((chapter) => chapter.id === generationTarget.id)
                  : undefined
              const volumeGenerating =
                (generationTarget?.kind === 'volume' && generationTarget.id === group.volume.id) ||
                (!expanded && Boolean(generatingChapter))
              const volumeGenerationLabel = generatingChapter?.title ?? group.volume.title
              const volumeGenerationTargetId = generatingChapter?.id ?? group.volume.id

              return (
                <div key={group.volume.id} className="space-y-1">
                  <button
                    type="button"
                    aria-controls={chapterListId}
                    aria-expanded={expanded}
                    data-workbench-volume-row="true"
                    onClick={() => toggleVolume(group.volume.id)}
                    className={cn(
                      SIDEBAR_ROW_CLASS,
                      'justify-between text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Folder className="size-4 shrink-0 text-hint-foreground" />
                      <span className="truncate">{group.volume.title}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {volumeGenerating ? (
                        <SidebarGenerationPill label={volumeGenerationLabel} targetId={volumeGenerationTargetId} />
                      ) : volumeTag ? (
                        <span
                          className={cn(
                            'shrink-0 rounded-row px-1.5 py-0.5 text-[11px] font-medium leading-none',
                            volumeTag.className,
                          )}
                          data-workbench-volume-tag={volumeTag.id}
                        >
                          {volumeTag.label}
                        </span>
                      ) : null}
                      <ChevronRight
                        className={cn(
                          'size-3.5 shrink-0 text-hint-foreground transition-transform duration-200',
                          expanded && 'rotate-90',
                        )}
                      />
                    </span>
                  </button>
                  <AnimatePresence initial={false}>
                    {expanded ? (
                      <motion.div
                        id={chapterListId}
                        key={chapterListId}
                        data-workbench-chapter-list={group.volume.id}
                        data-workbench-chapter-list-motion={group.volume.id}
                        initial={{ height: 0, opacity: 0, y: -2 }}
                        animate={{ height: 'auto', opacity: 1, y: 0 }}
                        exit={{ height: 0, opacity: 0, y: -2 }}
                        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="space-y-1 pl-6">
                          {group.chapters.map((chapter) => {
                            const active = selectedObjectId === chapter.id
                            const tag = resolveChapterDirectoryTag({
                              chapterId: chapter.id,
                              currentChapterId,
                              status: chapter.status,
                            })
                            const chapterGenerating =
                              generationTarget?.kind === 'chapter' && generationTarget.id === chapter.id
                            const chapterHref = buildWorkbenchObjectHref({
                              projectPath: project.path,
                              objectId: chapter.id,
                            })

                            return (
                              <Link
                                key={chapter.id}
                                to={chapterHref}
                                aria-current={active ? 'page' : undefined}
                                data-active={active}
                                className={cn(
                                  SIDEBAR_ROW_CLASS,
                                  'justify-between',
                                  active
                                    ? 'bg-active font-semibold text-foreground hover:bg-active'
                                    : 'text-muted-foreground hover:bg-hover hover:text-foreground',
                                )}
                                onClick={(event) => handleGuardedNavigation(event, chapterHref)}
                              >
                                <span className="flex min-w-0 items-center">
                                  <span className="min-w-0 truncate">{chapter.title}</span>
                                  {typeof chapter.chapterNumber === 'number' &&
                                    manuscriptDraftChapters.has(chapter.chapterNumber) && (
                                      <span
                                        aria-label="有正文恢复草稿"
                                        title="有未保存的正文恢复草稿"
                                        className="ml-1 inline-block size-1.5 shrink-0 rounded-full bg-primary"
                                        data-manuscript-draft-dot="true"
                                      />
                                    )}
                                  {typeof chapter.chapterNumber === 'number' && pendingMap[String(chapter.chapterNumber)] && (
                                    <span
                                      aria-label="记忆待同步"
                                      title="正文改动后记忆尚未同步"
                                      className="ml-1 inline-block size-1.5 shrink-0 rounded-full bg-warning"
                                      data-pending-memory-sync-dot="true"
                                    />
                                  )}
                                  {chapter.status === 'completed' &&
                                    typeof chapter.chapterNumber === 'number' &&
                                    plannedStateCounts[String(chapter.chapterNumber)] > 0 && (
                                      <span
                                        aria-label="计划状态变更未兑现"
                                        title={`${plannedStateCounts[String(chapter.chapterNumber)]} 项计划状态变更未兑现`}
                                        className="ml-1 inline-block size-1.5 shrink-0 rounded-full bg-warning"
                                        data-undelivered-state-dot="true"
                                      />
                                    )}
                                </span>
                                {chapterGenerating ? (
                                  <SidebarGenerationPill label={chapter.title} targetId={chapter.id} />
                                ) : tag ? (
                                  <span
                                    className={cn(
                                      'shrink-0 rounded-row px-1.5 py-0.5 text-[11px] font-medium leading-none',
                                      tag.className,
                                    )}
                                    data-workbench-chapter-tag={tag.id}
                                  >
                                    {tag.label}
                                  </span>
                                ) : null}
                              </Link>
                            )
                          })}
                        </div>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              )
            })}
          </nav>
        </div>
      </ScrollArea>
    </section>
  )
}

export function WorkbenchPrimarySidebar({
  activeRun,
  error,
  hasProjectPath,
  loading,
  project,
  selectedSectionId,
  selectedObjectId,
}: {
  activeRun?: AgentRun | null
  error: string | null
  hasProjectPath: boolean
  loading: boolean
  project: NovelProjectDetail | null
  selectedSectionId: WorkbenchPrimarySectionId
  selectedObjectId?: string | null
}) {
  const sections = project ? getWorkbenchPrimarySections(project) : []
  const projectPath = project?.path ?? ''
  const isChapterSelected = selectedObjectId?.startsWith('chapter-') === true
  const generationTarget = resolveWorkbenchSidebarGenerationTarget({ activeRun: activeRun ?? null, project })
  const navigate = useNavigate()
  const location = useLocation()
  const workbenchReturnTarget = `${location.pathname}${location.search}`

  function handleGuardedNavigation(
    event: MouseEvent<HTMLAnchorElement>,
    href: string,
    state?: Record<string, unknown>,
  ) {
    if (!useManuscriptEditorGuard.getState().dirty) return
    event.preventDefault()
    void confirmLeaveManuscriptEditor().then((leave) => {
      if (leave) navigate(href, state ? { state } : undefined)
    })
  }

  return (
    <aside
      className="relative flex h-full min-h-0 w-full min-w-0 flex-col bg-canvas"
      data-workbench-primary-sidebar="true"
    >
      <div
        className="flex h-14 shrink-0 items-center justify-end gap-2 pl-[var(--titlebar-inset-left)] pr-3 [-webkit-app-region:drag]"
        data-workbench-sidebar-headbar="true"
      >
        <IconTooltip label="返回图书馆">
          <Button asChild variant="ghost" size="icon-sm" className="[-webkit-app-region:no-drag]">
            <Link
              to="/"
              aria-label="返回图书馆"
              onClick={(event) => handleGuardedNavigation(event, '/')}
            >
              <House className="size-4" />
            </Link>
          </Button>
        </IconTooltip>
        <GlobalNotificationBell placement="sidebar" className="[-webkit-app-region:no-drag]" />
        <IconTooltip label="打开设置">
          <Button asChild variant="ghost" size="icon-sm" className="[-webkit-app-region:no-drag]">
            <Link
              to="/settings"
              state={{ from: workbenchReturnTarget }}
              aria-label="打开设置"
              onClick={(event) => handleGuardedNavigation(event, '/settings', { from: workbenchReturnTarget })}
            >
              <Settings className="size-4" />
            </Link>
          </Button>
        </IconTooltip>
      </div>

      <div className="shrink-0 px-2 pb-4" data-workbench-sidebar-fixed-menu="true">
        <div className="mb-5 px-2">
          <div className="truncate text-base font-semibold leading-tight text-foreground">
            {projectTitle(project, loading, error, hasProjectPath)}
          </div>
          <div className="mt-1 truncate text-xs leading-none text-muted-foreground">
            {projectSubtitle(project, loading, error, hasProjectPath)}
          </div>
        </div>

        {sections.length > 0 ? (
          <nav aria-label="工作台主菜单" className="space-y-1" data-workbench-primary-menu="true">
            {sections.map((section) => {
              const active = !isChapterSelected && section.id === selectedSectionId
              const sectionGenerating =
                generationTarget?.kind === 'primary' && generationTarget.id === section.id
              const sectionHref = buildPrimarySectionHref({ projectPath, section })

              return (
                <Link
                  key={section.id}
                  to={sectionHref}
                  aria-current={active ? 'page' : undefined}
                  data-active={active}
                  className={cn(
                    SIDEBAR_ROW_CLASS,
                    'justify-between',
                    active
                      ? 'bg-active font-semibold text-foreground hover:bg-active'
                      : 'text-muted-foreground hover:bg-hover',
                  )}
                  onClick={(event) => handleGuardedNavigation(event, sectionHref)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {section.id === 'status' ? (
                      <Gauge
                        className="size-4 shrink-0 text-hint-foreground"
                        data-workbench-primary-section-icon="status"
                      />
                    ) : section.id === 'reference-works' ? (
                      <BookMarked
                        className="size-4 shrink-0 text-hint-foreground"
                        data-workbench-primary-section-icon="reference-works"
                      />
                    ) : section.id === 'settings' ? (
                      <NotebookTabs
                        className="size-4 shrink-0 text-hint-foreground"
                        data-workbench-primary-section-icon="settings"
                      />
                    ) : section.id === 'chat' ? (
                      <MessagesSquare
                        className="size-4 shrink-0 text-hint-foreground"
                        data-workbench-primary-section-icon="chat"
                      />
                    ) : section.id === 'packs' ? (
                      <Package
                        className="size-4 shrink-0 text-hint-foreground"
                        data-workbench-primary-section-icon="packs"
                      />
                    ) : section.id === 'memory-graph' ? (
                      <Waypoints
                        className="size-4 shrink-0 text-hint-foreground"
                        data-workbench-primary-section-icon="memory-graph"
                      />
                    ) : section.id === 'blueprint' ? (
                      <BookOpen
                        className="size-4 shrink-0 text-hint-foreground"
                        data-workbench-primary-section-icon="blueprint"
                      />
                    ) : (
                      <Settings
                        className="size-4 shrink-0 text-hint-foreground"
                        data-workbench-primary-section-icon="unknown"
                      />
                    )}
                    <span className="truncate">{section.title}</span>
                  </span>
                  {sectionGenerating ? (
                    <SidebarGenerationPill label={section.title} targetId={section.id} />
                  ) : section.pending ? (
                    <span className={cn(WARNING_PILL_CLASS, 'shrink-0')}>待设定</span>
                  ) : null}
                </Link>
              )
            })}
          </nav>
        ) : null}
      </div>
      {project?.problem ? (
        <div className="shrink-0 px-2 pb-3" data-workbench-project-problem="true">
          <div className="rounded-row bg-destructive/10 px-2.5 py-1.5 text-xs leading-snug text-destructive">
            {project.problem}
          </div>
        </div>
      ) : null}
      {project ? (
        <WorkbenchChapterDirectory
          generationTarget={generationTarget}
          project={project}
          selectedObjectId={selectedObjectId}
        />
      ) : null}
      <UpdateReadyBanner
        className="absolute inset-x-2 bottom-3 z-10"
        onBeforeInstall={confirmLeaveManuscriptEditor}
      />
    </aside>
  )
}

function SidebarGenerationPill({ label, targetId }: { label: string; targetId: string }) {
  return (
    <span
      aria-label={`正在生成${label}`}
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-row bg-brand/10 px-1.5 text-[11px] font-medium leading-none text-brand"
      data-workbench-sidebar-generation={targetId}
    >
      <Loader2 aria-hidden="true" className="size-3 animate-spin" />
      <span>生成中</span>
    </span>
  )
}
