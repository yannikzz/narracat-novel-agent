import { isProjectIncompleteError } from '@shared/lib/ipc-error'
import { Link } from 'react-router'
import { Fragment, useEffect } from 'react'
import { Check, CircleAlert, Gauge, Loader2, RefreshCw } from 'lucide-react'
import { BrandIllustration, type BrandIllustrationPurpose } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getWorkbenchActionIcon } from './workbench-action-icons'
import { getNarraCatCommandHumanLabel } from '@/lib/agent-commands'
import { getLibraryCoverPreset } from '@/lib/library-covers'
import {
  DESTRUCTIVE_INLINE_CLASS,
  EMPTY_PRIMARY_BODY_CLASS,
  EMPTY_PRIMARY_TITLE_CLASS,
  WORKBENCH_GUIDE_ACTION_CLASS,
} from '@/design-system'
import { cn } from '@/lib/cn'
import {
  resolveStatusLifecycleIndex,
  resolveStatusNextStep,
  type StatusNextStep,
  type WorkbenchAction,
} from '@/lib/workbench-actions'
import { useWorkbenchStatusStore, type WorkbenchStatusPhase } from '@/lib/workbench-status-store'
import {
  formatStatusTimestamp,
  formatWordCount,
  resolveForeshadowingStateLabel,
  resolveForeshadowingTypeLabel,
} from '@/lib/workbench-status-format'
import type {
  NovelProjectDetail,
  NovelStatusArc,
  NovelStatusForeshadowing,
  NovelStatusForeshadowingState,
  NovelStatusForeshadowingType,
  NovelStatusSnapshot,
} from '@shared/types/novel'

// 页头对齐其他菜单页规范（WorkbenchObjectHeader）：h-14、纯标题、可拖拽窗口区。
const STATUS_HEADER_CLASS =
  'flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-workspace px-5 [-webkit-app-region:drag]'

// 统一卡片：圆角 + 边框 + 抬升表面 + 较松内边距（提高呼吸感）。
const STATUS_CARD_CLASS = 'rounded-panel border border-border bg-surface px-5 py-5'

// 创作生命周期：立项 → 设定 → 大纲 → 连载 → 完结（当前阶段由 resolveStatusLifecycleIndex 给出）。
// 「设定」= 世界观与角色，是引擎创作链里真实的一步（ADR-0040）；此前 stepper 没有它，
// 于是指针让作者去创建角色、状态页却显示当前在「大纲」，两处对不上。用词与工作台的
// 「设定集」一致，点过去就是那里。
const LIFECYCLE_STAGES = ['立项', '设定', '大纲', '连载', '完结'] as const

// 下 4 组信息进 Tab 切换（上方「概览 + 进度 + 中断进度」固定）。
const STATUS_TABS = [
  { id: 'current-arc', label: '当前剧情' },
  { id: 'foreshadowing', label: '伏笔' },
  { id: 'review-failures', label: '未过审' },
  { id: 'references', label: '参考' },
] as const

// 伏笔大小类型配色（severity）：大→红 / 中→橙 / 小→品牌蓝。
const FORESHADOW_TYPE_TONE: Record<NovelStatusForeshadowingType, string> = {
  major: 'bg-destructive/10 text-destructive',
  medium: 'bg-warning/10 text-warning',
  small: 'bg-brand/10 text-brand',
}
// 伏笔状态配色（progress）：已登记→灰 / 已埋设→蓝 / 推进中→橙 / 已揭示→绿。
const FORESHADOW_STATE_TONE: Record<NovelStatusForeshadowingState, string> = {
  registered: 'bg-active text-muted-foreground',
  planted: 'bg-brand/10 text-brand',
  developing: 'bg-warning/10 text-warning',
  revealed: 'bg-success/10 text-success',
}

const FORESHADOW_TAG_CLASS = 'rounded-row px-1.5 py-0.5 text-[11px] font-medium leading-none'

function StatusStat({ label, value }: { label: string; value: string }) {
  return (
    <div data-status-metric={label}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-base font-semibold leading-tight text-foreground">{value}</div>
    </div>
  )
}

/** 内容顶部书头：小说封面 + 大标题（+ 类型）。 */
function StatusBookHeader({ title, genre, coverPreset }: { title: string; genre?: string; coverPreset?: string }) {
  const cover = getLibraryCoverPreset(coverPreset)
  return (
    <div className="flex items-center gap-4" data-status-book-header="true">
      <span className="block aspect-[2/3] w-20 shrink-0 overflow-hidden rounded-row bg-active shadow-[0_8px_18px_rgba(24,24,27,0.14)]">
        <img src={cover.src} alt="" className="h-full w-full object-cover" />
      </span>
      <div className="min-w-0">
        <h2 className="truncate text-2xl font-semibold leading-tight text-foreground">{title}</h2>
        {genre ? <div className="mt-1.5 text-xs text-muted-foreground">{genre}</div> : null}
      </div>
    </div>
  )
}

/** Tab 空态：与设定集空页一致——品牌插图 + 标题（+ 说明），留足留白。 */
function StatusTabEmpty({
  purpose,
  title,
  description,
}: {
  purpose: BrandIllustrationPurpose
  title: string
  description?: string
}) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <BrandIllustration purpose={purpose} size="md" decorative className="mb-3" />
      <div className={EMPTY_PRIMARY_TITLE_CLASS}>{title}</div>
      {description ? <p className={cn('mt-1.5', EMPTY_PRIMARY_BODY_CLASS)}>{description}</p> : null}
    </div>
  )
}

function StatusProgressBar({ percentage }: { percentage: number }) {
  const clamped = Math.max(0, Math.min(100, percentage))
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-active" data-status-progress-bar={clamped}>
      <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${clamped}%` }} />
    </div>
  )
}

/** 创作生命周期 stepper：已完成阶段打勾、当前阶段高亮、未来阶段置灰。 */
function StatusLifecycle({ activeIndex }: { activeIndex: number }) {
  return (
    <div className="flex flex-col gap-2" data-status-lifecycle={activeIndex}>
      <div className="flex items-center">
        {LIFECYCLE_STAGES.map((stage, index) => {
          const done = index < activeIndex
          const current = index === activeIndex
          return (
            <Fragment key={stage}>
              <span
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold',
                  current
                    ? 'border-brand bg-brand text-brand-foreground'
                    : done
                      ? 'border-brand-border bg-brand/15 text-brand'
                      : 'border-border bg-active text-muted-foreground',
                )}
                data-status-lifecycle-stage={stage}
                data-active={current}
              >
                {done ? <Check className="size-3" /> : index + 1}
              </span>
              {index < LIFECYCLE_STAGES.length - 1 ? (
                <span className={cn('h-0.5 flex-1 rounded-full', index < activeIndex ? 'bg-brand' : 'bg-border')} />
              ) : null}
            </Fragment>
          )
        })}
      </div>
      <div className="flex items-center justify-between">
        {LIFECYCLE_STAGES.map((stage, index) => (
          <span
            key={stage}
            className={cn('text-[11px]', index === activeIndex ? 'font-semibold text-foreground' : 'text-muted-foreground')}
          >
            {stage}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * 概览卡：生命周期 stepper + 阶段感知「下一步」CTA。
 * nextStep 'action' → 描述 + 派发按钮；'done' → 全书完成；null（项目无效）则由调用方决定是否渲染整卡。
 */
function StatusLifecycleCard({
  activeIndex,
  nextStep,
  onAction,
}: {
  activeIndex: number
  nextStep: StatusNextStep
  onAction?: (action: WorkbenchAction) => void
}) {
  return (
    <section className="space-y-5 rounded-panel border border-brand-border bg-brand/5 px-5 py-5" data-status-section="lifecycle">
      <StatusLifecycle activeIndex={activeIndex} />

      {nextStep?.kind === 'done' ? (
        <div className="border-t border-brand-border pt-4" data-status-next-step="done">
          <div className="text-xs font-medium text-brand">下一步</div>
          <div className="mt-0.5 text-sm font-semibold text-foreground">全书已完成 🎉</div>
        </div>
      ) : nextStep?.kind === 'action' ? (
        <div className="flex items-center justify-between gap-3 border-t border-brand-border pt-4">
          <div className="min-w-0">
            <div className="text-xs font-medium text-brand">下一步</div>
            <div className="mt-0.5 truncate text-sm leading-snug text-muted-foreground">{nextStep.action.description}</div>
          </div>
          {(() => {
            const { Icon } = getWorkbenchActionIcon(nextStep.action)
            return (
              <Button
                type="button"
                size="sm"
                className="shrink-0"
                data-status-next-step-action={nextStep.action.id}
                disabled={!onAction || !nextStep.action.enabled}
                onClick={() => onAction?.(nextStep.action)}
              >
                <Icon className="size-3.5" />
                {nextStep.action.label}
              </Button>
            )
          })()}
        </div>
      ) : null}
    </section>
  )
}

/** 当前剧情线（原「当前 Arc」，改用读者易懂措辞）：大气卡片展示篇章标题 + 章节区间 + 核心悬念 + 关键转折。 */
export function CurrentArcBlock({ arc }: { arc: NovelStatusArc | null | undefined }) {
  return (
    <section data-status-section="current-arc">
      {arc ? (
        <div className={cn(STATUS_CARD_CLASS, 'space-y-4')}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">当前剧情</div>
              <div className="mt-1 text-base font-semibold leading-snug text-foreground">{arc.title}</div>
            </div>
            {arc.chapterStart !== null && arc.chapterEnd !== null ? (
              <span className="shrink-0 rounded-full border border-border bg-active px-2.5 py-1 text-xs text-muted-foreground">
                第 {arc.chapterStart}–{arc.chapterEnd} 章
              </span>
            ) : null}
          </div>
          {arc.coreQuestion ? (
            <div className="space-y-1">
              <div className="text-xs font-medium text-hint-foreground">核心悬念</div>
              <div className="text-sm leading-relaxed text-foreground">{arc.coreQuestion}</div>
            </div>
          ) : null}
          {arc.irreversibleChange ? (
            <div className="space-y-1">
              <div className="text-xs font-medium text-hint-foreground">关键转折</div>
              <div className="text-sm leading-relaxed text-foreground">{arc.irreversibleChange}</div>
            </div>
          ) : null}
        </div>
      ) : (
        <StatusTabEmpty purpose="outline-needed" title="暂无当前剧情线" description="规划大纲后，这里会展示当前所在的剧情线。" />
      )}
    </section>
  )
}

/** 伏笔卡片网格（一行 3 张）：tag（类型+状态，分色）→ 内容 → 目标章节，留足呼吸感。 */
export function ForeshadowingBlock({ items }: { items: NovelStatusForeshadowing[] | undefined }) {
  return (
    <section data-status-section="foreshadowing">
      {items && items.length > 0 ? (
        <div className="grid grid-cols-3 gap-3" data-status-foreshadowing-list="true">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex flex-col gap-2.5 rounded-panel border border-border bg-surface p-3.5"
              data-status-foreshadowing={item.id}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={cn(FORESHADOW_TAG_CLASS, FORESHADOW_TYPE_TONE[item.type])}>
                  {resolveForeshadowingTypeLabel(item.type)}伏笔
                </span>
                <span className={cn(FORESHADOW_TAG_CLASS, FORESHADOW_STATE_TONE[item.state])}>
                  {resolveForeshadowingStateLabel(item.state)}
                </span>
                {item.overdue ? (
                  <span
                    className={cn(FORESHADOW_TAG_CLASS, 'bg-destructive/10 text-destructive')}
                    data-status-foreshadowing-overdue="true"
                  >
                    临期未兑现
                  </span>
                ) : null}
              </div>
              <div className="text-sm leading-snug text-foreground">{item.description}</div>
              {item.targetReveal ? (
                <div className="mt-auto text-xs text-muted-foreground">目标第 {item.targetReveal} 章揭示</div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <StatusTabEmpty purpose="outline-needed" title="暂无追踪中的伏笔" description="规划伏笔后，这里会展示它们的埋设与揭示进度。" />
      )}
    </section>
  )
}

export function ReviewFailuresBlock({ chapters }: { chapters: number[] | undefined }) {
  return (
    <section data-status-section="review-failures">
      {chapters && chapters.length > 0 ? (
        <div className="space-y-2.5" data-status-review-failures="true">
          <div className="text-xs text-muted-foreground">共 {chapters.length} 章未通过审校</div>
          <div className="flex flex-wrap gap-2">
            {chapters.map((chapter) => (
              <span
                key={chapter}
                className="rounded-row bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive"
                data-status-review-fail-chapter={chapter}
              >
                第 {chapter} 章
              </span>
            ))}
          </div>
        </div>
      ) : (
        <StatusTabEmpty purpose="review-needed" title="章节全部通过审校" description="没有待修订的章节，继续保持。" />
      )}
    </section>
  )
}

export function ReferencesBlock({ snapshot }: { snapshot: NovelStatusSnapshot }) {
  const references = snapshot.references
  return (
    <section data-status-section="references">
      {references && references.sourceCount > 0 ? (
        <div className={cn(STATUS_CARD_CLASS, 'flex items-center justify-between gap-2 py-4')}>
          <span className="text-sm text-foreground">{references.sourceCount} 篇原文</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            参考指导{references.guidanceGenerated ? '已生成' : '未生成'}
          </span>
        </div>
      ) : (
        <StatusTabEmpty
          purpose="reference-works-needed"
          title="暂无参考作品"
          description="添加参考原文后，这里会展示参考指导的生成状态。"
        />
      )}
    </section>
  )
}

export function WorkbenchStatusSnapshotView({
  snapshot,
  coverPreset,
  lifecycleIndex,
  nextStep,
  onNextStepAction,
}: {
  snapshot: NovelStatusSnapshot
  coverPreset?: string
  lifecycleIndex?: number | null
  nextStep?: StatusNextStep
  onNextStepAction?: (action: WorkbenchAction) => void
}) {
  const { progress, checkpoint } = snapshot
  // 丰富区块按降级处理：字段缺失（未提供 / 空）时各区块显示「未规划 / 无 / 全部通过」。
  const hasEnrichment =
    snapshot.currentArc !== undefined ||
    snapshot.foreshadowing !== undefined ||
    snapshot.reviewFailures !== undefined ||
    snapshot.references !== undefined

  return (
    <div className="flex flex-col gap-4 px-6 py-5 sm:px-8 sm:py-6" data-workbench-status-snapshot="true">
      <StatusBookHeader title={snapshot.book.title} genre={snapshot.book.genre} coverPreset={coverPreset} />

      {typeof lifecycleIndex === 'number' ? (
        <StatusLifecycleCard activeIndex={lifecycleIndex} nextStep={nextStep ?? null} onAction={onNextStepAction} />
      ) : null}

      <section className={cn(STATUS_CARD_CLASS, 'space-y-4')} data-status-section="progress">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">章节完成度</span>
          <span className="text-xs text-muted-foreground">{progress.percentage}%</span>
        </div>
        <StatusProgressBar percentage={progress.percentage} />
        <div className="grid grid-cols-3 gap-3">
          <StatusStat label="完成章节" value={`${progress.completedChapters} / ${progress.totalChaptersPlanned}`} />
          <StatusStat label="总字数" value={formatWordCount(progress.wordCountTotal)} />
          <StatusStat label="单章均字" value={formatWordCount(progress.avgWordsPerChapter)} />
        </div>
      </section>

      <section className={cn(STATUS_CARD_CLASS, 'space-y-3')} data-status-section="checkpoint">
        <div className="text-sm font-medium text-foreground">上次中断的进度</div>
        {checkpoint && checkpoint.lastCommand ? (
          <div>
            <div className="text-sm text-foreground">{getNarraCatCommandHumanLabel(checkpoint.lastCommand)}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {checkpoint.lastStep !== null ? `步骤 ${checkpoint.lastStep} · ` : ''}
              {formatStatusTimestamp(checkpoint.timestamp)}
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">没有未完成的任务。</div>
        )}
      </section>

      {hasEnrichment ? (
        <Tabs defaultValue="current-arc" className="gap-4" data-status-tabs="true">
          <TabsList className="w-full">
            {STATUS_TABS.map((tab) => (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                data-status-tab={tab.id}
                className="data-[state=active]:bg-surface data-[state=active]:hover:bg-surface"
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="current-arc">
            <CurrentArcBlock arc={snapshot.currentArc} />
          </TabsContent>
          <TabsContent value="foreshadowing">
            <ForeshadowingBlock items={snapshot.foreshadowing} />
          </TabsContent>
          <TabsContent value="review-failures">
            <ReviewFailuresBlock chapters={snapshot.reviewFailures?.map((failure) => failure.chapter)} />
          </TabsContent>
          <TabsContent value="references">
            <ReferencesBlock snapshot={snapshot} />
          </TabsContent>
        </Tabs>
      ) : null}
    </div>
  )
}

function WorkbenchStatusFailure({
  error,
  onRetry,
  retrying,
}: {
  error: string | null
  onRetry: () => void
  retrying: boolean
}) {
  // 项目文件不完整时重试一万次都是同一个错，给出路而不是给重试按钮；
  // 原始错误只进主进程日志，不推到作者面前（#38）。
  if (error && isProjectIncompleteError(error)) {
    return (
      <div className={cn(DESTRUCTIVE_INLINE_CLASS, 'mb-4 flex items-start gap-2')} data-workbench-status-failure="true">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">这本书的项目文件不完整</div>
          <div className="mt-0.5 break-words text-xs leading-snug opacity-90">
            暂时算不出写作进度。常见原因是文件夹被移动或重命名，也可能是它所在的磁盘没有连接。
          </div>
        </div>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="shrink-0"
          data-workbench-status-back-to-library="true"
        >
          <Link to="/">返回书架</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className={cn(DESTRUCTIVE_INLINE_CLASS, 'mb-4 flex items-start gap-2')} data-workbench-status-failure="true">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">状态更新失败</div>
        <div className="mt-0.5 break-words text-xs leading-snug opacity-90">{error ?? '请稍后重试。'}</div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        disabled={retrying}
        data-workbench-status-retry="true"
        onClick={onRetry}
      >
        <RefreshCw className="size-3" />
        重试
      </Button>
    </div>
  )
}

/**
 * 纯展示态面板：四态（空 / 完成 / 更新中 / 失败）渲染由 props 决定，不读 store，
 * 便于按状态做确定性渲染测试。store 接线与阶段解析在 WorkbenchStatusPanel。
 */
export function WorkbenchStatusPanelView({
  phase,
  snapshot,
  error,
  coverPreset,
  lifecycleIndex,
  nextStep,
  onNextStepAction,
  onRefresh,
}: {
  phase: WorkbenchStatusPhase
  snapshot: NovelStatusSnapshot | null
  error: string | null
  coverPreset?: string
  lifecycleIndex?: number | null
  nextStep?: StatusNextStep
  onNextStepAction?: (action: WorkbenchAction) => void
  onRefresh: () => void
}) {
  const refreshing = phase === 'refreshing'
  const failed = phase === 'failed'
  // 无快照即展示空态引导（含首进新项目 refreshing 时：按钮转圈禁用、不空屏）；
  // 失败时若已有上一次成功快照则仍展示完成态主体（失败态只叠加横幅，不抹掉快照）。
  const showEmpty = !snapshot

  function handleRefresh() {
    if (refreshing) return
    onRefresh()
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-workbench-status-panel="true" data-status-phase={phase}>
      <header className={STATUS_HEADER_CLASS} data-workbench-status-titlebar="true">
        <h1 className="truncate text-sm font-semibold text-foreground">小说状态</h1>
        <div className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
          {snapshot ? (
            <span className="text-xs text-muted-foreground" data-status-updated-at="true">
              更新于 {formatStatusTimestamp(snapshot.generatedAt)}
            </span>
          ) : null}
          {snapshot || failed ? (
            <IconTooltip label={refreshing ? '更新中' : '更新状态'}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="更新状态"
                disabled={refreshing}
                data-workbench-status-refresh="true"
                onClick={handleRefresh}
              >
                {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              </Button>
            </IconTooltip>
          ) : null}
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        {showEmpty ? (
          <div className="flex h-full flex-col px-6 py-5 sm:px-8 sm:py-6">
            {failed ? <WorkbenchStatusFailure error={error} onRetry={handleRefresh} retrying={refreshing} /> : null}
            <div className="flex flex-1 items-center justify-center" data-workbench-status-empty="true">
              <div className="mx-auto flex max-w-sm flex-col items-center text-center">
                <BrandIllustration purpose="checkpoint" size="lg" decorative className="mb-4" />
                <h2 className={EMPTY_PRIMARY_TITLE_CLASS}>还没有状态快照</h2>
                <p className={`mt-2 ${EMPTY_PRIMARY_BODY_CLASS}`}>
                  聚合当前小说的章节进度、字数和上次中断的位置，生成一份状态快照。
                </p>
                <Button
                  type="button"
                  size="lg"
                  className={`mt-5 ${WORKBENCH_GUIDE_ACTION_CLASS}`}
                  disabled={refreshing}
                  data-workbench-status-empty-action="true"
                  onClick={handleRefresh}
                >
                  {refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <Gauge className="size-3.5" />}
                  查看状态
                </Button>
              </div>
            </div>
          </div>
        ) : failed && snapshot ? (
          <div className="px-6 pt-5 sm:px-8 sm:pt-6">
            <WorkbenchStatusFailure error={error} onRetry={handleRefresh} retrying={refreshing} />
          </div>
        ) : null}
        {!showEmpty && snapshot ? (
          // 刷新时内容整体渐隐（仅 opacity，不插入撑高的长条 loading，避免页面上下跳动）。
          <div
            className={cn('transition-opacity duration-300', refreshing && 'pointer-events-none opacity-50')}
            aria-busy={refreshing}
            data-status-refreshing={refreshing ? 'true' : undefined}
          >
            <WorkbenchStatusSnapshotView
              snapshot={snapshot}
              coverPreset={coverPreset}
              lifecycleIndex={lifecycleIndex}
              nextStep={nextStep}
              onNextStepAction={onNextStepAction}
            />
          </div>
        ) : null}
      </ScrollArea>
    </div>
  )
}

export function WorkbenchStatusPanel({
  project,
  onAction,
}: {
  project: NovelProjectDetail | null
  onAction?: (action: WorkbenchAction) => void
}) {
  const projectPath = project?.path ?? ''
  const phase = useWorkbenchStatusStore((state) => state.phase)
  const snapshot = useWorkbenchStatusStore((state) => state.snapshot)
  const error = useWorkbenchStatusStore((state) => state.error)
  const enter = useWorkbenchStatusStore((state) => state.enter)
  const refresh = useWorkbenchStatusStore((state) => state.refresh)

  // 每次进入 status 面板都走一遍 SWR：秒显落盘快照 + 后台重算原地替换。
  // 面板切走即卸载、切回即重新挂载，故 mount 等价于「进入面板」，依赖仅 projectPath。
  useEffect(() => {
    if (!projectPath) return
    void enter(projectPath)
  }, [projectPath, enter])

  const nextStep = resolveStatusNextStep(project)

  return (
    <WorkbenchStatusPanelView
      phase={phase}
      snapshot={snapshot}
      error={error}
      coverPreset={project?.coverPreset}
      lifecycleIndex={resolveStatusLifecycleIndex(project, nextStep)}
      nextStep={nextStep}
      onNextStepAction={onAction}
      onRefresh={() => {
        if (projectPath) void refresh(projectPath)
      }}
    />
  )
}
