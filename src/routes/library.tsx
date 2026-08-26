import { useEffect, useMemo, useRef, useState, type FormEvent, type FormEventHandler, type ImgHTMLAttributes } from 'react'
import { Link } from 'react-router'
import { canRemoveFromLibrary } from '@shared/lib/library-project'
import { toast } from 'sonner'
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  Image as ImageIcon,
  ListFilter,
  Loader2,
  MoreHorizontal,
  Pencil,
  Search,
  Settings as SettingsIcon,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { BrandIllustration, BrandLockup } from '@/components/brand'
import { GlobalNotificationBell } from '@/components/notifications/GlobalNotificationBell'
import { LoadRecoveryNotice } from '@/components/LoadRecoveryNotice'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { AppShell } from '@/components/AppShell'
import {
  CREATE_NOVEL_AUTOMATION_AUTO_HELP,
  CREATE_NOVEL_AUTOMATION_AUTO_LABEL,
  CREATE_NOVEL_AUTOMATION_COLLABORATIVE_HELP,
  CREATE_NOVEL_AUTOMATION_COLLABORATIVE_LABEL,
  CreateNovelDialog,
} from '@/components/library/CreateNovelDialog'
import { UpdateReadyBanner } from '@/components/settings/UpdateReadyBanner'
import {
  DESTRUCTIVE_INLINE_CLASS,
  EMPTY_COMPACT_BODY_CLASS,
  EMPTY_COMPACT_TITLE_CLASS,
  EMPTY_PRIMARY_BODY_CLASS,
  EMPTY_PRIMARY_TITLE_CLASS,
  WORKBENCH_GUIDE_ACTION_CLASS,
  WORKSPACE_SHELL_CLASS,
} from '@/design-system'
import { cn } from '@/lib/cn'
import { getLibraryCoverPreset, listLibraryCoverPresets } from '@/lib/library-covers'
import { getAgentThreadIdForProject, useAgentStore } from '@/lib/agent-store'
import {
  filterLibraryProjects,
  getLibraryGenreFilters,
  normalizeLibraryGenre,
  sortLibraryProjects,
} from '@/lib/library-projects'
import type { LibraryGenreFilter, LibraryStatusFilter } from '@/lib/library-projects'
import { useNovelStore } from '@/lib/novel-store'
import { createLoadIssue } from '@/lib/load-state'
import {
  createNovelProjectBackup,
  restoreNovelProjectBackup,
  writeWorkLocation,
} from '@/lib/ipc'
import {
  deleteLibraryProject,
  reloadLibraryProjects,
  saveLibraryProjectMetadata,
  useLibraryProjects,
} from '@/lib/use-novel-project'
import type { NovelAutomationLevel, NovelProjectSummary } from '@shared/types/novel'

type LibrarySummary = {
  total: number
  completed: number
  /** 全库原始总字数（纯文字）。banner 显示时再缩写。 */
  words: number
}

type ImageLoading = NonNullable<ImgHTMLAttributes<HTMLImageElement>['loading']>

const STATUS_FILTER_OPTIONS: Array<{ value: LibraryStatusFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'in-progress', label: '写作中' },
  { value: 'ready', label: '可写作' },
  { value: 'needs-outline', label: '待大纲' },
  { value: 'needs-setup', label: '待设定' },
  { value: 'invalid', label: '需检查' },
]

export const LIBRARY_PROJECT_METADATA_DIALOG_CONTENT_CLASS =
  'max-h-[calc(100dvh-2rem)] overflow-hidden bg-workspace p-0 sm:max-w-[640px]'

export const LIBRARY_PROJECT_DELETE_DIALOG_CONTENT_CLASS = 'bg-workspace sm:max-w-[520px]'
export const LIBRARY_PROJECT_BACKUP_DIALOG_CONTENT_CLASS = 'bg-workspace sm:max-w-[520px]'

const LIBRARY_AUTOMATION_LEVEL_LABELS: Record<NovelAutomationLevel, string> = {
  auto: CREATE_NOVEL_AUTOMATION_AUTO_LABEL,
  collaborative: CREATE_NOVEL_AUTOMATION_COLLABORATIVE_LABEL,
}

/**
 * 切换入口的后果说明与新建对话框同源（同一份文案常量）：改档改的是 Agent 之后怎么跑，
 * 光给两个单选项等于让作者盲选，这里必须把「换来什么、代价是什么」摆在选项里。
 */
const LIBRARY_AUTOMATION_LEVEL_HELP: Record<NovelAutomationLevel, string> = {
  auto: CREATE_NOVEL_AUTOMATION_AUTO_HELP,
  collaborative: CREATE_NOVEL_AUTOMATION_COLLABORATIVE_HELP,
}

/** 「更多」菜单里的自动化入口文案：常态显示当前档，Agent 运行中改成说明原因（与备份/删除一致）。 */
export function libraryAutomationMenuLabel(automationLevel: NovelAutomationLevel, blocked: boolean): string {
  return blocked ? 'Agent 运行中，不能切换模式' : `自动化：${LIBRARY_AUTOMATION_LEVEL_LABELS[automationLevel]}`
}

export function statusLabel(status: NovelProjectSummary['status']): string {
  if (status === 'ready') return '可写作'
  if (status === 'needs-setup') return '待设定'
  if (status === 'needs-outline') return '待大纲'
  if (status === 'in-progress') return '写作中'
  return '需检查'
}

function projectStatusBadgeClass(project: NovelProjectSummary): string {
  // 章节写满即完结：用实心品牌绿与浅绿「可写作」区分，且优先于断点/状态。
  if (isCompletedProject(project)) return 'bg-[#1b8f43] text-white'
  if (project.checkpoint) return 'bg-warning/14 text-warning'
  if (project.status === 'ready') return 'bg-[#d6eedc] text-[#1b8f43]'
  if (project.status === 'invalid') return 'bg-destructive/10 text-destructive'
  if (project.status === 'needs-setup' || project.status === 'needs-outline') return 'bg-warning/14 text-warning'
  return 'bg-active text-muted-foreground'
}

function projectStatusBadgeLabel(project: NovelProjectSummary): string {
  // 完结是终态，覆盖断点「未完成」后缀。
  if (isCompletedProject(project)) return '完结'
  return project.checkpoint ? `${statusLabel(project.status)} · 未完成` : statusLabel(project.status)
}

/**
 * banner 字数缩写：区域有限，≥1万显示「3.5万」（整万去掉 .0），不足 1万显示原数（带千分位）。
 */
function formatBannerWordNumber(words: number): string {
  if (words >= 10000) {
    const wan = words / 10000
    const text = wan >= 10 ? Math.round(wan).toString() : wan.toFixed(1).replace(/\.0$/, '')
    return `${text}万`
  }
  return new Intl.NumberFormat('zh-CN').format(words)
}

function isCompletedProject(project: NovelProjectSummary): boolean {
  const progress = project.chapterProgress.match(/(\d+)\s*\/\s*(\d+)/)
  if (!progress) return false

  const completed = Number(progress[1])
  const total = Number(progress[2])
  return total > 0 && completed >= total
}

export function summarizeLibraryProjects(projects: NovelProjectSummary[]): LibrarySummary {
  const completed = projects.filter(isCompletedProject).length
  const words = projects.reduce((total, project) => total + (project.wordCountTotal ?? 0), 0)

  return {
    total: projects.length,
    completed,
    words,
  }
}

function formatUpdatedAt(updatedAt?: string): string {
  if (!updatedAt) return '未记录更新时间'

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(updatedAt))
}

function formatCardProgress(progress: string): string {
  return progress.replace(/\s*\/\s*/g, '/').replace(/\s+章/g, '章')
}

function formatCardWordCount(words: string): string {
  return words.replace(/\s+字/g, '字')
}

export function LibraryNavBrand() {
  return <BrandLockup data-library-nav-brand="true" size="md" />
}

export function LibraryEmptyState({ loading }: { loading: boolean }) {
  return (
    <div
      data-library-empty-state="true"
      className="flex min-h-[328px] items-center justify-center px-4 pb-4 pt-10 text-center"
    >
      <div className="mx-auto max-w-[360px]">
        {loading ? (
          <div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-[16px] bg-active text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : (
          <div
            data-library-empty-illustration="true"
            className="mx-auto mb-5 flex h-40 items-center justify-center"
          >
            <BrandIllustration
              purpose="empty-library"
              size="lg"
              className="mx-auto"
            />
          </div>
        )}
        <h2 className={`${EMPTY_PRIMARY_TITLE_CLASS} leading-tight`}>
          {loading ? '正在读取小说项目' : '开始第一部小说'}
        </h2>
        <p className={`mt-2 ${EMPTY_PRIMARY_BODY_CLASS}`}>
          {loading ? '正在扫描小说根目录。' : '创建后会进入创作工作台，Agent 会继续协助完善设定。'}
        </p>
        {!loading && (
          <div className="mt-5 flex justify-center">
            <CreateNovelDialog
              triggerLabel="新建小说"
              triggerVariant="default"
              triggerSize="lg"
              triggerClassName={WORKBENCH_GUIDE_ACTION_CLASS}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export function LibraryFilteredEmptyState({ onReset }: { onReset: () => void }) {
  return (
    <div
      data-library-filtered-empty-state="true"
      className="flex min-h-[240px] items-center justify-center rounded-panel border border-dashed border-border px-4 text-center"
    >
      <div className="max-w-sm">
        <div className="mx-auto mb-3 flex size-9 items-center justify-center rounded-full bg-active text-muted-foreground">
          <ListFilter className="size-4" />
        </div>
        <div className={EMPTY_COMPACT_TITLE_CLASS}>没有符合筛选的小说</div>
        <p className={`mt-2 ${EMPTY_COMPACT_BODY_CLASS}`}>
          换个书名关键词，或调整状态、题材筛选，继续浏览当前小说库。
        </p>
        <div className="mt-5 flex justify-center">
          <Button type="button" variant="secondary" size="sm" onClick={onReset}>
            <X className="size-3.5" />
            清除筛选
          </Button>
        </div>
      </div>
    </div>
  )
}

export function LibraryFilterBar({
  genreFilter,
  onGenreFilterChange,
  onStatusFilterChange,
  onTitleQueryChange,
  filteredCount,
  projects,
  statusFilter,
  titleQuery,
}: {
  filteredCount: number
  genreFilter: LibraryGenreFilter
  onGenreFilterChange: (filter: LibraryGenreFilter) => void
  onStatusFilterChange: (filter: LibraryStatusFilter) => void
  onTitleQueryChange: (query: string) => void
  projects: NovelProjectSummary[]
  statusFilter: LibraryStatusFilter
  titleQuery: string
}) {
  const genreFilters = getLibraryGenreFilters(projects)
  const filtersActive = statusFilter !== 'all' || genreFilter !== 'all' || titleQuery.trim() !== ''
  const filterSummary = filtersActive ? `显示 ${filteredCount} / ${projects.length} 部` : '全部状态 · 全部题材'

  return (
    <div
      className="mb-9 mt-12 flex items-center justify-between gap-6"
      data-library-filter-bar="true"
    >
      <div className="min-w-0">
        <h2 data-library-works-heading="true" className="text-[24px] font-semibold leading-tight text-foreground">
          我的作品
        </h2>
        <div className="sr-only">{filterSummary}</div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative" data-library-title-search="true">
          <span className="sr-only">搜索书名</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-hint-foreground" />
          <input
            type="search"
            className="h-9 w-[200px] rounded-[12px] border border-border bg-surface py-0 pl-8 pr-3 text-sm font-medium text-foreground outline-none transition-all duration-200 placeholder:text-hint-foreground hover:bg-hover focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
            placeholder="搜索书名"
            value={titleQuery}
            onChange={(event) => onTitleQueryChange(event.target.value)}
          />
        </label>

        <label className="relative" data-library-status-select="true">
          <span className="sr-only">状态筛选</span>
          <select
            className="h-9 appearance-none rounded-[12px] border border-border bg-surface py-0 pl-3.5 pr-8 text-sm font-medium text-foreground outline-none transition-all duration-200 hover:bg-hover focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
            value={statusFilter}
            onChange={(event) => onStatusFilterChange(event.target.value as LibraryStatusFilter)}
          >
            {STATUS_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-hint-foreground" />
        </label>

        <label className="relative" data-library-genre-select="true">
          <span className="sr-only">题材筛选</span>
          <select
            className="h-9 appearance-none rounded-[12px] border border-border bg-surface py-0 pl-3.5 pr-8 text-sm font-medium text-foreground outline-none transition-all duration-200 hover:bg-hover focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
            value={genreFilter}
            onChange={(event) => onGenreFilterChange(event.target.value as LibraryGenreFilter)}
          >
            <option value="all">全部题材</option>
            {genreFilters.map((genre) => (
              <option key={genre} value={genre}>
                {genre}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-hint-foreground" />
        </label>
      </div>
    </div>
  )
}

export function LibraryHomeHero({ summary }: { summary: LibrarySummary }) {
  const metrics = [
    { label: '作品数', value: summary.total },
    { label: '已完结', value: summary.completed },
    { label: '字数', value: formatBannerWordNumber(summary.words) },
  ]

  return (
    <section
      data-library-home-hero="true"
      className="relative mx-auto h-[463px] w-full overflow-visible"
      aria-label="小说库总览"
    >
      <div
        data-library-home-banner="true"
        className="absolute inset-x-0 bottom-0 h-[390px] overflow-hidden rounded-[14px] bg-[#04c853]"
      >
        <div className="absolute left-[3.8%] top-[48px] z-10 w-[43%] max-w-[630px] text-white 2xl:w-[49%] 2xl:max-w-[740px]">
          <h1 className="text-[44px] font-bold leading-[1.12]">
            故事生于人，
            <br />
            成于智能。
          </h1>
          <p className="mt-6 text-[16px] font-medium leading-[1.65] text-white/88">
            在人类文明中，故事一直来自人的记忆、情感与想象。
            <br />
            从口述，到书写，再到数字时代，技术不断改变表达方式，但创造故事的，始终是人。
          </p>
        </div>

        <div
          data-library-home-metrics="true"
          className="absolute bottom-[48px] left-[3.8%] z-10 grid w-[38.2%] grid-cols-3 gap-3"
        >
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className="grid min-h-[88px] place-items-center rounded-[10px] bg-white/13 px-3 text-center text-white"
            >
              <div>
                <div className="text-[26px] font-semibold leading-none tabular">{metric.value}</div>
                <div className="mt-2 text-sm font-medium leading-none text-white/82">{metric.label}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <IconTooltip label="点击查看Agent档案" side="bottom" align="center">
        <Link
          to="/settings?section=agents"
          state={{ from: '/' }}
          aria-label="点击查看Agent档案"
          data-library-agent-profile-link="true"
          className="
            group absolute bottom-0 right-[6.2%] z-20 inline-flex h-[clamp(340px,32vw,463px)] w-auto max-w-none
            select-none items-end rounded-row focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-white/55
          "
        >
          <BrandIllustration
            purpose="home-agents"
            decorative
            loading="eager"
            data-library-home-agents="true"
            className="
              h-full w-auto max-w-none origin-bottom select-none object-contain
              transition-transform duration-300 ease-out group-hover:scale-[1.025] group-focus-visible:scale-[1.025]
            "
          />
        </Link>
      </IconTooltip>
    </section>
  )
}

export type LibraryProjectMetadataIntent = 'edit-title' | 'change-cover'

export function LibraryProjectMetadataPanel({
  formError,
  intent = 'edit-title',
  onCoverPresetChange,
  onSubmit,
  onTitleChange,
  project,
  saving,
  selectedCoverPreset,
  title,
}: {
  formError: string | null
  /** 打开来源：「更换封面」进来时自动滚到封面区并聚焦当前封面；默认「编辑标题」不变。 */
  intent?: LibraryProjectMetadataIntent
  onCoverPresetChange: (coverPreset: string) => void
  onSubmit: FormEventHandler<HTMLFormElement>
  onTitleChange: (title: string) => void
  project: NovelProjectSummary
  saving: boolean
  selectedCoverPreset: string
  title: string
}) {
  const coverPresets = listLibraryCoverPresets()
  const coverSectionRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (intent !== 'change-cover') return
    // 等 Dialog 的默认聚焦（标题输入框）先落，再把焦点和视口挪到封面区。
    const frame = requestAnimationFrame(() => {
      const section = coverSectionRef.current
      if (!section) return
      section.scrollIntoView({ block: 'start' })
      section.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [intent])

  return (
    <form
      onSubmit={onSubmit}
      data-library-project-metadata-panel="true"
      className="grid max-h-[calc(100dvh-2rem)] min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]"
    >
      <DialogHeader className="border-b border-border px-6 pb-5 pt-6 text-left">
        <DialogTitle className="text-lg leading-tight">编辑小说信息</DialogTitle>
        <DialogDescription className="sr-only">更新当前书卡的显示标题和内置封面。</DialogDescription>
      </DialogHeader>

      <div data-library-project-metadata-scroll="true" className="min-h-0 overflow-y-auto px-6 py-5">
        <div className="grid gap-5">
          <label className="grid gap-2 text-xs font-medium text-muted-foreground">
            <span>显示标题</span>
            <Input
              className="h-9 rounded-row bg-workspace px-3 text-base"
              value={title}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder={project.title}
            />
          </label>

          <div ref={coverSectionRef} data-library-cover-section="true" className="grid scroll-mt-5 gap-2">
            <div className="text-xs font-medium text-muted-foreground">内置封面</div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {coverPresets.map((cover) => {
                const selected = selectedCoverPreset === cover.id

                return (
                  <button
                    key={cover.id}
                    type="button"
                    aria-pressed={selected}
                    data-library-cover-option={cover.id}
                    data-library-cover-selected={selected ? 'true' : undefined}
                    className={cn(
                      `
                      group/cover rounded-row bg-transparent text-left transition-all duration-200
                      focus-visible:outline-none
                      focus-visible:ring-[3px] focus-visible:ring-ring/50
                    `,
                      selected && 'text-foreground'
                    )}
                    onClick={() => onCoverPresetChange(cover.id)}
                  >
                    <span className="relative block aspect-[2/3] origin-bottom-left overflow-hidden rounded-row bg-active shadow-[0_10px_20px_rgba(24,24,27,0.10)] transition-transform duration-500 ease-out group-hover/cover:-translate-y-0.5 group-hover/cover:rotate-[-1deg] group-hover/cover:scale-[1.025]">
                      <img
                        src={cover.src}
                        alt=""
                        aria-hidden="true"
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover transition-transform duration-700 ease-out group-hover/cover:scale-[1.055]"
                      />
                      {selected && (
                        <span
                          aria-hidden="true"
                          data-library-cover-selected-indicator="true"
                          className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-brand text-white ring-2 ring-surface shadow-[0_4px_10px_rgba(4,200,83,0.28)]"
                        >
                          <Check className="size-3.5 text-white" strokeWidth={3} />
                        </span>
                      )}
                    </span>
                    <span
                      className={cn(
                        'mt-1.5 block truncate text-[11px] font-medium leading-tight',
                        selected ? 'text-foreground' : 'text-muted-foreground'
                      )}
                    >
                      {cover.label}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {formError && (
            <div className={`${DESTRUCTIVE_INLINE_CLASS} text-xs`} role="alert">
              {formError}
            </div>
          )}
        </div>
      </div>

      <DialogFooter data-library-project-metadata-footer="true" className="border-t border-border bg-active/40 px-6 py-4">
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          保存修改
        </Button>
      </DialogFooter>
    </form>
  )
}

function LibraryProjectManagementDialog({
  intent,
  onOpenChange,
  open,
  project,
}: {
  intent: LibraryProjectMetadataIntent
  onOpenChange: (open: boolean) => void
  open: boolean
  project: NovelProjectSummary
}) {
  const [title, setTitle] = useState(project.title)
  const [selectedCoverPreset, setSelectedCoverPreset] = useState(getLibraryCoverPreset(project.coverPreset).id)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setTitle(project.title)
    setSelectedCoverPreset(getLibraryCoverPreset(project.coverPreset).id)
    setFormError(null)
  }, [open, project.coverPreset, project.title])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const nextTitle = title.trim()
    if (!nextTitle) {
      setFormError('请输入小说标题。')
      return
    }

    setSaving(true)
    setFormError(null)

    try {
      await saveLibraryProjectMetadata({
        projectPath: project.path,
        title: nextTitle,
        coverPreset: selectedCoverPreset,
      })
      onOpenChange(false)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={LIBRARY_PROJECT_METADATA_DIALOG_CONTENT_CLASS}>
        <LibraryProjectMetadataPanel
          formError={formError}
          intent={intent}
          onCoverPresetChange={setSelectedCoverPreset}
          onSubmit={submit}
          onTitleChange={setTitle}
          project={project}
          saving={saving}
          selectedCoverPreset={selectedCoverPreset}
          title={title}
        />
      </DialogContent>
    </Dialog>
  )
}

export function isLibraryProjectDeleteConfirmationValid(title: string, confirmationTitle: string): boolean {
  return confirmationTitle.trim() === title.trim()
}

export function LibraryProjectDeletePanel({
  confirmationTitle,
  deleteBlocked,
  deleting,
  formError,
  onCancel,
  onConfirmationTitleChange,
  onSubmit,
  project,
}: {
  confirmationTitle: string
  deleteBlocked: boolean
  deleting: boolean
  formError: string | null
  onCancel: () => void
  onConfirmationTitleChange: (title: string) => void
  onSubmit: FormEventHandler<HTMLFormElement>
  project: NovelProjectSummary
}) {
  const confirmationValid = isLibraryProjectDeleteConfirmationValid(project.title, confirmationTitle)

  return (
    <form onSubmit={onSubmit} data-library-project-delete-panel="true" className="grid gap-5">
      <DialogHeader className="pr-8 text-left">
        <DialogTitle className="text-lg leading-tight">删除小说</DialogTitle>
        <DialogDescription>
          “{project.title}”会被移到系统废纸篓，并从小说库中移除。恢复请前往系统废纸篓。
        </DialogDescription>
      </DialogHeader>

      <label className="grid gap-2 text-xs font-medium text-muted-foreground">
        <span>输入小说标题以确认</span>
        <Input
          aria-invalid={confirmationTitle.length > 0 && !confirmationValid}
          className="h-9 rounded-row bg-surface px-3 text-base"
          data-library-project-delete-confirmation="true"
          value={confirmationTitle}
          onChange={(event) => onConfirmationTitleChange(event.target.value)}
          placeholder={project.title}
        />
      </label>

      {deleteBlocked && (
        <div className={`${DESTRUCTIVE_INLINE_CLASS} text-xs`} role="alert">
          Agent 正在处理这部小说，结束后才能删除。
        </div>
      )}

      {formError && (
        <div className={`${DESTRUCTIVE_INLINE_CLASS} text-xs`} role="alert">
          {formError}
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="secondary" disabled={deleting} onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" variant="destructive" disabled={deleting || deleteBlocked || !confirmationValid}>
          {deleting && <Loader2 className="size-4 animate-spin" />}
          删除小说
        </Button>
      </DialogFooter>
    </form>
  )
}

function LibraryProjectDeleteDialog({
  deleteBlocked,
  onOpenChange,
  open,
  project,
}: {
  deleteBlocked: boolean
  onOpenChange: (open: boolean) => void
  open: boolean
  project: NovelProjectSummary
}) {
  const [confirmationTitle, setConfirmationTitle] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setConfirmationTitle('')
    setFormError(null)
  }, [open])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (deleteBlocked) {
      setFormError('Agent 正在处理这部小说，结束后才能删除。')
      return
    }

    if (!isLibraryProjectDeleteConfirmationValid(project.title, confirmationTitle)) {
      setFormError('请输入完整小说标题以确认删除。')
      return
    }

    setDeleting(true)
    setFormError(null)

    try {
      await deleteLibraryProject({
        projectPath: project.path,
        title: project.title,
        confirmationTitle,
      })
      onOpenChange(false)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={LIBRARY_PROJECT_DELETE_DIALOG_CONTENT_CLASS}>
        <LibraryProjectDeletePanel
          confirmationTitle={confirmationTitle}
          deleteBlocked={deleteBlocked}
          deleting={deleting}
          formError={formError}
          onCancel={() => onOpenChange(false)}
          onConfirmationTitleChange={setConfirmationTitle}
          onSubmit={submit}
          project={project}
        />
      </DialogContent>
    </Dialog>
  )
}

function LibraryProjectBackupDialog({
  backupBlocked,
  onOpenChange,
  open,
  project,
}: {
  backupBlocked: boolean
  onOpenChange: (open: boolean) => void
  open: boolean
  project: NovelProjectSummary
}) {
  const [backingUp, setBackingUp] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setErrorMessage(null)
  }, [open])

  async function createBackup() {
    if (backupBlocked) {
      setErrorMessage('Agent 正在处理这部小说，结束后才能备份。')
      return
    }
    setBackingUp(true)
    setErrorMessage(null)
    try {
      const result = await createNovelProjectBackup(project.path)
      if (result.status === 'canceled') return
      toast.success(`备份已创建：${result.filePath}`)
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBackingUp(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={LIBRARY_PROJECT_BACKUP_DIALOG_CONTENT_CLASS}>
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="text-lg leading-tight">备份小说项目</DialogTitle>
          <DialogDescription>
            备份会包含“{project.title}”的完整小说内容、草稿、修订记录和项目内未知文件。
            备份文件不加密，请妥善保管。
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-row bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-warning">
          创建期间会暂时阻止 Agent 和项目写入，以保证备份内容来自同一时刻。
        </div>

        {backupBlocked && (
          <div className={`${DESTRUCTIVE_INLINE_CLASS} text-xs`} role="alert">
            Agent 正在处理这部小说，结束后才能备份。
          </div>
        )}
        {errorMessage && (
          <div className={`${DESTRUCTIVE_INLINE_CLASS} text-xs`} role="alert">
            {errorMessage}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="secondary" disabled={backingUp} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" disabled={backingUp || backupBlocked} onClick={() => void createBackup()}>
            {backingUp && <Loader2 className="size-4 animate-spin" />}
            选择位置并备份
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function LibraryProjectManagementMenu({ project }: { project: NovelProjectSummary }) {
  const [metadataIntent, setMetadataIntent] = useState<LibraryProjectMetadataIntent | null>(null)
  const [backupDialogOpen, setBackupDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const projectThreadId = getAgentThreadIdForProject(project)
  const deleteBlocked = useAgentStore((state) => {
    if (state.threadsById[projectThreadId]?.activeRun) return true

    return Object.values(state.threadsById).some((thread) => thread.activeRun?.projectPath === project.path)
  })
  const automationLevel = project.automationLevel

  async function switchAutomationLevel(nextLevel: NovelAutomationLevel) {
    if (nextLevel === automationLevel) return

    try {
      await saveLibraryProjectMetadata({ projectPath: project.path, automationLevel: nextLevel })
      toast.success(`已切换到${LIBRARY_AUTOMATION_LEVEL_LABELS[nextLevel]}，下一次规划大纲或写作时生效。`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '切换自动化模式失败，请重试。')
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="更多"
            data-library-card-menu-trigger="true"
            className="pointer-events-auto text-muted-foreground"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6}>
          <DropdownMenuItem onSelect={() => setMetadataIntent('edit-title')}>
            <Pencil className="size-4" />
            编辑标题
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setMetadataIntent('change-cover')}>
            <ImageIcon className="size-4" />
            更换封面
          </DropdownMenuItem>
          {automationLevel && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger
                disabled={deleteBlocked}
                data-library-project-automation-menu-item="true"
                className="data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
              >
                <Wand2 className="size-4" />
                {libraryAutomationMenuLabel(automationLevel, deleteBlocked)}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-72">
                <DropdownMenuRadioGroup
                  value={automationLevel}
                  onValueChange={(value) => void switchAutomationLevel(value as NovelAutomationLevel)}
                >
                  <DropdownMenuRadioItem value="auto" className="items-start">
                    <span className="grid gap-0.5">
                      <span>{LIBRARY_AUTOMATION_LEVEL_LABELS.auto}</span>
                      <span className="text-xs font-normal leading-5 text-hint-foreground">
                        {LIBRARY_AUTOMATION_LEVEL_HELP.auto}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="collaborative" className="items-start">
                    <span className="grid gap-0.5">
                      <span>{LIBRARY_AUTOMATION_LEVEL_LABELS.collaborative}</span>
                      <span className="text-xs font-normal leading-5 text-hint-foreground">
                        {LIBRARY_AUTOMATION_LEVEL_HELP.collaborative}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={deleteBlocked}
            data-library-project-backup-menu-item="true"
            onSelect={() => setBackupDialogOpen(true)}
          >
            <Archive className="size-4" />
            {deleteBlocked ? 'Agent 运行中，不能备份' : '备份小说'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={deleteBlocked}
            data-library-project-delete-menu-item="true"
            onSelect={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="size-4" />
            {deleteBlocked ? 'Agent 运行中，不能删除' : '删除小说'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <LibraryProjectManagementDialog
        project={project}
        intent={metadataIntent ?? 'edit-title'}
        open={metadataIntent !== null}
        onOpenChange={(open) => {
          if (!open) setMetadataIntent(null)
        }}
      />
      <LibraryProjectBackupDialog
        project={project}
        open={backupDialogOpen}
        backupBlocked={deleteBlocked}
        onOpenChange={setBackupDialogOpen}
      />
      <LibraryProjectDeleteDialog
        project={project}
        open={deleteDialogOpen}
        deleteBlocked={deleteBlocked}
        onOpenChange={setDeleteDialogOpen}
      />
    </>
  )
}


export const LIBRARY_INVALID_PROJECT_DIALOG_CONTENT_CLASS = 'sm:max-w-[440px]'

/**
 * 损坏项目说明浮层（#38）。
 *
 * invalid 很可能是误判——文件夹被移动/重命名、外置盘没插、config.yaml 被误删而正文还在。
 * 所以主动作是「打开所在文件夹」让作者自己看一眼，而不是引导他先删东西。
 */
export function LibraryInvalidProjectPanel({
  canRemove,
  onCancel,
  onRemove,
  onReveal,
  project,
  removing,
}: {
  canRemove: boolean
  onCancel: () => void
  onRemove: () => void
  onReveal: () => void
  project: NovelProjectSummary
  removing: boolean
}) {
  return (
    <div data-library-invalid-project-panel="true" className="grid gap-5">
      <DialogHeader className="pr-8 text-left">
        <DialogTitle className="text-lg leading-tight">这本书暂时打不开</DialogTitle>
        <DialogDescription>
          “{project.title}”的项目文件不完整，NarraCat 读不出它的进度和正文。常见原因是文件夹被移动或重命名，也可能是它所在的磁盘没有连接。
        </DialogDescription>
      </DialogHeader>

      <p className="text-xs leading-relaxed text-muted-foreground">
        建议先打开文件夹看一眼：文件还在的话，放回原处就能恢复。
        {canRemove
          ? '确认不需要了，可以只把它从书架上移除——不会删掉任何文件。'
          : '这本书就放在你的小说文件夹里，确认不要了请用卡片右上角「更多」里的删除。'}
      </p>

      <DialogFooter className="gap-2 sm:justify-between">
        <Button type="button" variant="ghost" onClick={onCancel}>
          知道了
        </Button>
        <div className="flex gap-2">
          {canRemove ? (
            <Button
              type="button"
              variant="outline"
              data-library-invalid-remove="true"
              disabled={removing}
              onClick={onRemove}
            >
              {removing ? '移除中…' : '从书架移除'}
            </Button>
          ) : null}
          <Button type="button" data-library-invalid-reveal="true" onClick={onReveal}>
            打开所在文件夹
          </Button>
        </div>
      </DialogFooter>
    </div>
  )
}

export function LibraryInvalidProjectDialog({
  open,
  onOpenChange,
  project,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: NovelProjectSummary
}) {
  const [novelRootDir, setNovelRootDir] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.electron
      ?.getConfig?.()
      .then((payload) => {
        if (!cancelled) setNovelRootDir(payload?.config?.novelRootDir ?? null)
      })
      .catch(() => {
        if (!cancelled) setNovelRootDir(null)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // 读不到 novelRootDir 时按「不能移除」处理：宁可少给一个按钮，也不给点了不生效的。
  const canRemove = novelRootDir ? canRemoveFromLibrary(project.path, novelRootDir) : false

  async function remove() {
    setRemoving(true)
    try {
      // 对 invalid 项目，删除流程本就只摘书架条目、不动任何文件（novel-delete.ts）。
      await deleteLibraryProject({
        projectPath: project.path,
        title: project.title,
        confirmationTitle: project.title,
      })
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={LIBRARY_INVALID_PROJECT_DIALOG_CONTENT_CLASS}>
        <LibraryInvalidProjectPanel
          canRemove={canRemove}
          project={project}
          removing={removing}
          onCancel={() => onOpenChange(false)}
          onRemove={() => void remove()}
          onReveal={() => void window.electron?.revealProjectFolder?.(project.path)}
        />
      </DialogContent>
    </Dialog>
  )
}

export function LibraryProjectCard({
  coverLoading = 'lazy',
  project,
}: {
  coverLoading?: ImageLoading
  project: NovelProjectSummary
}) {
  const cover = getLibraryCoverPreset(project.coverPreset)
  const isInvalid = project.status === 'invalid'
  const [noticeOpen, setNoticeOpen] = useState(false)
  // 损坏项目不把 `.narracat/config.yaml` 这类文件名糊到作者脸上，卡上只留一句人话，
  // 详情与出路放进点击后的说明浮层（#38）。
  const problem = isInvalid ? '项目文件不完整，点开看看能怎么办' : (project.problem ?? null)
  const displayGenre = normalizeLibraryGenre(project.genre)
  const chapterProgress = formatCardProgress(project.chapterProgress)
  const wordCount = formatCardWordCount(project.wordCountLabel)

  return (
    <article
      data-project-card
      className={cn(
        `
          group relative grid min-h-[196px] grid-cols-[108px_minmax(0,1fr)] gap-6 rounded-[16px] p-5
          transition-all duration-200 hover:bg-[#fafafa] active:scale-[0.99]
        `,
        project.status === 'invalid' && 'bg-destructive/5 hover:bg-destructive/10'
      )}
    >
      {isInvalid ? (
        // 进到一个什么都读不出来的工作台对作者零价值，入口先拦住。
        <button
          type="button"
          data-library-invalid-trigger="true"
          aria-label={`${project.title} 项目文件不完整，查看怎么办`}
          onClick={() => setNoticeOpen(true)}
          className="absolute inset-0 z-0 rounded-[16px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <Link
          to={`/workbench?project=${encodeURIComponent(project.path)}`}
          aria-label={`打开 ${project.title} 工作台`}
          className="absolute inset-0 z-0 rounded-[16px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      )}

      {isInvalid ? (
        <LibraryInvalidProjectDialog open={noticeOpen} onOpenChange={setNoticeOpen} project={project} />
      ) : null}


      <div
        data-library-book-cover="true"
        data-library-cover-preset={cover.id}
        className="pointer-events-none relative z-10 aspect-[2/3] w-[108px] origin-bottom-left overflow-hidden rounded-[8px] bg-active shadow-[0_12px_24px_rgba(24,24,27,0.14)] transition-transform duration-500 ease-out group-hover:-translate-y-0.5 group-hover:rotate-[-1deg] group-hover:scale-[1.025]"
      >
        <div className="relative h-full w-full">
          <img
            src={cover.src}
            alt=""
            aria-hidden="true"
            loading={coverLoading}
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.055]"
          />
          <div className="absolute inset-y-0 left-0 w-4 bg-gradient-to-r from-black/20 via-white/10 to-transparent" />
          <div className="absolute inset-y-2 right-2 w-px bg-white/20" />
        </div>
      </div>

      <div className="pointer-events-auto absolute right-5 top-6 z-20">
        <LibraryProjectManagementMenu project={project} />
      </div>

      <div data-library-card-content-layer="true" className="pointer-events-none relative z-10 flex min-w-0 flex-col pt-2">
        <div className="flex min-w-0 items-center gap-2 pr-10">
          <span className={cn('rounded-[6px] px-1.5 py-1 text-xs font-medium leading-none', projectStatusBadgeClass(project))}>
            {projectStatusBadgeLabel(project)}
          </span>
          <span className="rounded-[6px] bg-[#f1f1f1] px-1.5 py-1 text-xs font-medium leading-none text-[#9a9a9a]">
            {displayGenre}
          </span>
        </div>

        <h3 className="mt-3 min-w-0 truncate text-base font-semibold leading-tight text-foreground">
          {project.title}
        </h3>
        <time className="mt-1 text-xs font-medium leading-tight text-[#b1b1b1] tabular">
          上次更新 {formatUpdatedAt(project.updatedAt)}
        </time>

        <div className="mt-auto grid grid-cols-2 gap-2.5 pt-3">
          <div className="min-h-[52px] rounded-[8px] bg-[#f5f5f5] px-3 py-2">
            <div className="text-xs font-medium leading-none text-[#b8b8b8]">章节</div>
            <div className="mt-2 truncate text-sm font-semibold leading-none text-foreground tabular">
              {chapterProgress}
            </div>
          </div>
          <div className="min-h-[52px] rounded-[8px] bg-[#f5f5f5] px-3 py-2">
            <div className="text-xs font-medium leading-none text-[#b8b8b8]">字数</div>
            <div className="mt-2 truncate text-sm font-semibold leading-none text-foreground tabular">
              {wordCount}
            </div>
          </div>
        </div>

        {problem && (
          <div className="mt-2 min-w-0 truncate rounded-row bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
            {problem}
          </div>
        )}
      </div>
    </article>
  )
}

export function LibraryProjectGrid({ projects }: { projects: NovelProjectSummary[] }) {
  const sortedProjects = sortLibraryProjects(projects)

  return (
    <div data-library-project-grid="true" className="grid grid-cols-1 gap-y-10 xl:grid-cols-2 xl:gap-x-8">
      {sortedProjects.map((project, index) => (
        <LibraryProjectCard key={project.path} project={project} coverLoading={index < 4 ? 'eager' : 'lazy'} />
      ))}
    </div>
  )
}

export function LibraryRestoreBackupButton() {
  const [restoring, setRestoring] = useState(false)

  async function restoreBackup() {
    setRestoring(true)
    try {
      const result = await restoreNovelProjectBackup()
      if (result.status === 'canceled') return
      await reloadLibraryProjects()
      if (result.missingCapabilityPacks.length > 0) {
        const missing = result.missingCapabilityPacks
          .map((dependency) => `${dependency.id}@${dependency.version}`)
          .join('、')
        toast.warning(`小说已恢复；以下能力包已暂停：${missing}`)
      } else {
        toast.success(`已恢复“${result.project.title}”`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setRestoring(false)
    }
  }

  return (
    <IconTooltip label="恢复小说备份">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="恢复小说备份"
        disabled={restoring}
        onClick={() => void restoreBackup()}
      >
        {restoring ? <Loader2 className="size-4 animate-spin" /> : <ArchiveRestore className="size-4" />}
      </Button>
    </IconTooltip>
  )
}

export function LibraryRoute() {
  useLibraryProjects()
  useEffect(() => {
    void writeWorkLocation({ version: 1, landing: 'library' }).catch((error) => {
      createLoadIssue('startup', error)
    })
  }, [])
  const [statusFilter, setStatusFilter] = useState<LibraryStatusFilter>('all')
  const [genreFilter, setGenreFilter] = useState<LibraryGenreFilter>('all')
  const [titleQuery, setTitleQuery] = useState('')
  const diagnostics = useNovelStore((state) => state.diagnostics)
  const projects = useNovelStore((state) => state.projects)
  const loading = useNovelStore((state) => state.loading)
  const libraryLoad = useNovelStore((state) => state.libraryLoad)
  const diagnosticIssue = useMemo(
    () =>
      diagnostics?.status === 'invalid'
        ? createLoadIssue('diagnostics', new Error(diagnostics.errors.join('\n')))
        : null,
    [diagnostics],
  )
  const filteredProjects = useMemo(
    () => filterLibraryProjects(projects, { status: statusFilter, genre: genreFilter, title: titleQuery }),
    [genreFilter, projects, statusFilter, titleQuery],
  )
  const summary = summarizeLibraryProjects(projects)
  const resetFilters = () => {
    setStatusFilter('all')
    setGenreFilter('all')
    setTitleQuery('')
  }

  return (
    <AppShell
      navCenter={<LibraryNavBrand />}
      navEnd={
        <>
          <UpdateReadyBanner variant="titlebar" />
          {projects.length > 0 && <CreateNovelDialog />}
          <LibraryRestoreBackupButton />
          <GlobalNotificationBell />
          <Button asChild variant="ghost" size="icon" aria-label="设置">
            <Link to="/settings" state={{ from: '/' }}>
              <SettingsIcon className="size-4" />
            </Link>
          </Button>
        </>
      }
    >
      <main className="h-full min-h-0 p-4 pt-0">
        <section className={`${WORKSPACE_SHELL_CLASS} h-full min-h-0 overflow-auto px-6 pb-5 pt-2`}>
          <div className="mx-auto w-full max-w-[1400px] pb-9">
            <LibraryHomeHero summary={summary} />

            {projects.length > 0 && (
              <LibraryFilterBar
                projects={projects}
                filteredCount={filteredProjects.length}
                statusFilter={statusFilter}
                genreFilter={genreFilter}
                titleQuery={titleQuery}
                onStatusFilterChange={setStatusFilter}
                onGenreFilterChange={setGenreFilter}
                onTitleQueryChange={setTitleQuery}
              />
            )}

            {libraryLoad.issue ? (
              <LoadRecoveryNotice
                className="mb-4"
                from="/"
                issue={libraryLoad.issue}
                onRetry={() => void reloadLibraryProjects()}
                retrying={loading}
                stale={libraryLoad.status === 'stale'}
              />
            ) : null}
            {diagnosticIssue ? (
              <LoadRecoveryNotice
                className="mb-4"
                from="/"
                issue={diagnosticIssue}
                onRetry={() => void reloadLibraryProjects()}
                retrying={loading}
              />
            ) : null}

            {!libraryLoad.hasData ? (
              libraryLoad.status === 'error' ? null : <LibraryEmptyState loading />
            ) : projects.length === 0 ? (
              <LibraryEmptyState loading={loading} />
            ) : filteredProjects.length === 0 ? (
              <LibraryFilteredEmptyState onReset={resetFilters} />
            ) : (
              <LibraryProjectGrid projects={filteredProjects} />
            )}
          </div>
        </section>
      </main>
    </AppShell>
  )
}
