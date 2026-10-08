import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, FileText, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DESTRUCTIVE_INLINE_CLASS, EMPTY_PRIMARY_BODY_CLASS, EMPTY_PRIMARY_TITLE_CLASS, GROUP_CLASS, ROW_CLASS } from '@/design-system'
import { cn } from '@/lib/cn'
import { ensurePackLearnSubscription, usePackLearnStore } from '@/lib/pack-learn-store'
import type { PackLearnSession } from '@/lib/pack-learn-store'
import type { NovelProjectSummary } from '@shared/types/novel'
import type {
  PackDraftMeta,
  PackLearnEstimate,
  PackLearnReport,
  PackLearnSource,
  PackLearnTier,
} from '@shared/types/capability-pack'

type PickStep = 'pick-source' | 'pick-tier'

const TIER_OPTIONS: Array<{ value: PackLearnTier; title: string; body: string }> = [
  { value: 'skim', title: '选读 · 学味道', body: '快速读开头和抽样章节，学这本书的腔调和局部写法' },
  { value: 'deep', title: '精读 · 加骨架', body: '在选读基础上通读全书结构，多学剧情编排的方法' },
]

/** 「本次大约读 X 万字」（Math.round 到万字），不足 1 万字换成「不到 1 万字」——精确的字数没有意义。 */
function formatLearnEstimateText(approxChars: number): string {
  const wan = Math.round(approxChars / 10000)
  return wan < 1 ? '本次大约读不到 1 万字' : `本次大约读 ${wan} 万字`
}

/**
 * 「点了停止」本地态（`cancelling`）该不该重置：session 清空（cancelled 被 store 自动清空），或者
 * session 已经落到终态（`result` 非 null，即 done/error）——只要不再是「正在跑」这个状态，这个临时
 * 标记就该清掉。刻意不只看「session 变空」：`cancelling=true` 之后如果这次学习撞上真实异常落成
 * error（不是 cancelled，session 不会被自动清空），用户点「重试」重新起跑时 session 会从「error 终态」
 * 直接跳回「运行中」，中间从没变过 null——若重置只认 session 变空，`cancelling` 会一路带着 true 卡进
 * 下一轮运行，永久禁用停止按钮（评审 Medium）。纯函数：不摸 React state，独立于 DOM 单测。
 */
export function shouldResetCancelling(session: PackLearnSession | null): boolean {
  return !session || session.result !== null
}

/**
 * 造包中心「从书学写法」学习向导（B2 刀4 Task 12）：选源 → 选档 → 进行中 → 完成/失败 四步状态机。
 *
 * 进行中/完成/失败三态读 `usePackLearnStore`（模块级会话，非本组件 state）——`startLearn` 是分钟级
 * 长 Promise，组件随时可能因用户切子视图而卸载，会话状态提升到 store 才能撑住「学习在后台进行，
 * 你可以先去别处」这句承诺：重新进入本视图时，`session` 非空即接着显示当前进度/结果，不必重新选源。
 * 选源/选档两步是一次性向导输入，留在组件本地 state 即可（未开始学习前谈不上「离开再回来」）。
 * 返回入口在设置页 titlebar 面包屑（导航规范 §9.8），本视图不放返回按钮；选档页内的「换一本书」是
 * 向导内部的步骤回退，不是子视图导航，故保留一个轻量文字按钮。
 */
export function LearnFromBookView({ onOpenDraft }: { onOpenDraft: (draftId: string) => void }) {
  useEffect(() => {
    ensurePackLearnSubscription()
  }, [])

  const session = usePackLearnStore((state) => state.session)

  // 「正在停止…」按钮禁用态：取消不是瞬时的（rewriteCardBody 进行中不打断，有秒级延迟），点了就立刻
  // 给禁用反馈，不能让用户以为没点上而连点。重置条件用 `shouldResetCancelling`（纯函数，见下方）而不是
  // 只看「session 变空」——「停止」和一次真实失败可能撞车：用户点了停止，session 却因为撞上真实异常
  // 落成 error 终态（不是 cancelled，不会被 store 自动清空），此时若只在 session 变空时重置，
  // `cancelling` 会一直卡在 true；用户点「重试」（handleRetry）重新起跑后，运行页的停止按钮会永久
  // 禁用、点不动（评审 Medium）。改成「session 清空，或 session.result 落定」都重置——error/ok 终态
  // 一出现就立刻清掉这个临时标记，不必等到 session 真的被清空。
  const [cancelling, setCancelling] = useState(false)
  useEffect(() => {
    if (shouldResetCancelling(session)) setCancelling(false)
  }, [session])

  const [step, setStep] = useState<PickStep>('pick-source')
  const [novels, setNovels] = useState<NovelProjectSummary[]>([])
  const [drafts, setDrafts] = useState<PackDraftMeta[]>([])
  const [sourcesLoaded, setSourcesLoaded] = useState(false)
  const [pickBusyKey, setPickBusyKey] = useState<string | null>(null)
  const [sourceError, setSourceError] = useState<string | null>(null)

  const [source, setSource] = useState<PackLearnSource | null>(null)
  const [tier, setTier] = useState<PackLearnTier>('skim')
  const [estimate, setEstimate] = useState<PackLearnEstimate | null>(null)
  const [estimateLoading, setEstimateLoading] = useState(false)

  // 选源页数据：只在没有在跑/已到终态的会话时拉取（会话存在时本页根本不显示）；会话被清空（重新开始/
  // 打开草稿工程后回到选源）时会重新拉一次，让「已学过这本书」的提示反映刚学完的新工程。
  useEffect(() => {
    if (session) return
    let alive = true
    Promise.all([window.electron.listNovelProjects(), window.electron.listPackDrafts()])
      .then(([novelList, draftList]) => {
        if (!alive) return
        setNovels(novelList)
        setDrafts(draftList)
        setSourcesLoaded(true)
      })
      .catch(() => {
        if (alive) setSourcesLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [session])

  const learnedTitles = useMemo(
    () => new Set(drafts.flatMap((draft) => (draft.learnedFrom?.title ? [draft.learnedFrom.title] : []))),
    [drafts],
  )

  // 选档页快速切换选读/精读会连发两次 estimateLearn；用序号丢弃过期响应，避免慢的那次后到达
  // 把估算数字覆盖成跟当前选中档位对不上的旧值。
  const estimateRequestSeqRef = useRef(0)
  const runEstimate = useCallback(async (candidate: PackLearnSource, candidateTier: PackLearnTier) => {
    const requestSeq = ++estimateRequestSeqRef.current
    setEstimateLoading(true)
    try {
      const result = await window.electron.estimateLearn({ source: candidate, tier: candidateTier })
      if (requestSeq === estimateRequestSeqRef.current) setEstimate(result)
      return result
    } finally {
      if (requestSeq === estimateRequestSeqRef.current) setEstimateLoading(false)
    }
  }, [])

  const selectSource = useCallback(
    async (candidate: PackLearnSource, busyKey: string) => {
      if (pickBusyKey) return
      setPickBusyKey(busyKey)
      setSourceError(null)
      try {
        const result = await runEstimate(candidate, 'skim')
        if (result.status === 'error') {
          setSourceError(result.message)
          return
        }
        setSource(candidate)
        setTier('skim')
        setStep('pick-tier')
      } catch {
        setSourceError('读不出这本书的正文，请重试。')
      } finally {
        setPickBusyKey(null)
      }
    },
    [pickBusyKey, runEstimate],
  )

  const handlePickNovel = useCallback(
    (novel: NovelProjectSummary) => {
      void selectSource({ kind: 'novel', projectPath: novel.path, title: novel.title }, `novel:${novel.path}`)
    },
    [selectSource],
  )

  const handlePickBook = useCallback(async () => {
    if (pickBusyKey) return
    setPickBusyKey('file')
    try {
      const picked = await window.electron.pickLearnBook()
      if (!picked) return
      await selectSource({ kind: 'file', filePath: picked.filePath, title: picked.title }, 'file')
    } finally {
      setPickBusyKey((current) => (current === 'file' ? null : current))
    }
  }, [pickBusyKey, selectSource])

  const handleSelectTier = useCallback(
    (nextTier: PackLearnTier) => {
      if (!source || nextTier === tier) return
      setTier(nextTier)
      void runEstimate(source, nextTier)
    },
    [source, tier, runEstimate],
  )

  const handleBackToSource = useCallback(() => {
    setStep('pick-source')
    setSource(null)
    setEstimate(null)
    setSourceError(null)
  }, [])

  const handleStart = useCallback(() => {
    if (!source || estimate?.status !== 'ok') return
    usePackLearnStore.getState().startLearning(source, tier)
  }, [source, tier, estimate])

  const handleCancel = useCallback(() => {
    if (cancelling) return
    setCancelling(true)
    usePackLearnStore.getState().cancelLearning()
  }, [cancelling])

  const handleRetry = useCallback(() => {
    if (!session) return
    // 双保险：`shouldResetCancelling` 已经在 error 终态落地那一刻把 cancelling 清了，这里再显式清一次
    // 不改变行为，只是防这条路径以后被改动时悄悄失去保护（评审 Medium）。
    setCancelling(false)
    usePackLearnStore.getState().startLearning(session.source, session.tier)
  }, [session])

  const handleOpenDraft = useCallback(
    (draftId: string) => {
      usePackLearnStore.getState().clearSession()
      onOpenDraft(draftId)
    },
    [onOpenDraft],
  )

  const handleRestart = useCallback(() => {
    usePackLearnStore.getState().clearSession()
    setStep('pick-source')
    setSource(null)
    setEstimate(null)
    setSourceError(null)
  }, [])

  // 会话存在（跑中/已到终态）时，进度/结果页覆盖选源/选档态——离开视图再回来仍看得到当前进度。
  // cancelled 终态不会走到这里：store 收到 cancelled 结果直接清空 session，视图会落回下方选源页
  // （产品裁决 follow-up C：点「停止」就是不想要了，没有信息量支撑一屏「已停止」确认页）。
  if (session) {
    if (!session.result) {
      return (
        <LearnRunningStep
          message={session.event?.message ?? '正在准备……'}
          cancelling={cancelling}
          onCancel={handleCancel}
        />
      )
    }
    if (session.result.status === 'ok') {
      const result = session.result
      return (
        <LearnDoneStep
          report={result.report}
          onOpenDraft={() => handleOpenDraft(result.draftId)}
          onLearnAnother={handleRestart}
        />
      )
    }
    return (
      <LearnEndedStep
        message={session.result.message}
        primaryLabel="重试"
        onPrimary={handleRetry}
        onLearnAnother={handleRestart}
      />
    )
  }

  if (step === 'pick-tier' && source) {
    return (
      <LearnTierStep
        source={source}
        tier={tier}
        estimate={estimate}
        estimateLoading={estimateLoading}
        onSelectTier={handleSelectTier}
        onBack={handleBackToSource}
        onStart={handleStart}
      />
    )
  }

  return (
    <LearnSourceStep
      novels={novels}
      loaded={sourcesLoaded}
      learnedTitles={learnedTitles}
      pickBusyKey={pickBusyKey}
      sourceError={sourceError}
      onPickNovel={handlePickNovel}
      onPickBook={() => void handlePickBook()}
    />
  )
}

/** 选源页：书架书按钮列表 + 本地电子书入口；书架为空时只显示文件入口和简短提示。 */
function LearnSourceStep({
  novels,
  loaded,
  learnedTitles,
  pickBusyKey,
  sourceError,
  onPickNovel,
  onPickBook,
}: {
  novels: NovelProjectSummary[]
  loaded: boolean
  learnedTitles: Set<string>
  pickBusyKey: string | null
  sourceError: string | null
  onPickNovel: (novel: NovelProjectSummary) => void
  onPickBook: () => void
}) {
  return (
    <section className="space-y-3" data-learn-source-step="true">
      {sourceError ? (
        <p className={DESTRUCTIVE_INLINE_CLASS} data-learn-source-error="true">
          {sourceError}
        </p>
      ) : null}

      {!loaded ? (
        <p className="text-xs leading-5 text-muted-foreground">加载中…</p>
      ) : novels.length === 0 ? (
        <p className="text-xs leading-5 text-muted-foreground" data-learn-shelf-empty="true">
          书架里还没有小说，可以选本地电子书来学。
        </p>
      ) : (
        <div className={GROUP_CLASS} data-learn-shelf-list="true">
          {novels.map((novel) => {
            const busyKey = `novel:${novel.path}`
            const busy = pickBusyKey === busyKey
            const alreadyLearned = learnedTitles.has(novel.title)
            return (
              <button
                key={novel.path}
                type="button"
                className={cn('flex w-full items-center gap-3 px-3 py-2.5 text-left', ROW_CLASS)}
                disabled={pickBusyKey !== null}
                data-learn-pick-novel={novel.path}
                onClick={() => onPickNovel(novel)}
              >
                <BookOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm leading-tight text-foreground">{novel.title}</span>
                  {alreadyLearned ? (
                    <span className="block text-xs leading-5 text-muted-foreground">已学过这本书，会另开一个新工程</span>
                  ) : null}
                </span>
                {busy ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
              </button>
            )
          })}
        </div>
      )}

      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={pickBusyKey !== null}
        data-learn-pick-book-trigger="true"
        onClick={onPickBook}
      >
        {pickBusyKey === 'file' ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
        选本地电子书（TXT / EPUB / PDF）
      </Button>
    </section>
  )
}

/** 选档页：两档卡片（选读/精读）+ 底部预估文案 + 「开始学习」。 */
function LearnTierStep({
  source,
  tier,
  estimate,
  estimateLoading,
  onSelectTier,
  onBack,
  onStart,
}: {
  source: PackLearnSource
  tier: PackLearnTier
  estimate: PackLearnEstimate | null
  estimateLoading: boolean
  onSelectTier: (tier: PackLearnTier) => void
  onBack: () => void
  onStart: () => void
}) {
  const canStart = !estimateLoading && estimate?.status === 'ok'
  return (
    <section className="space-y-3" data-learn-tier-step="true">
      <button
        type="button"
        onClick={onBack}
        className="text-xs leading-5 text-muted-foreground transition-colors duration-200 hover:text-foreground"
        data-learn-tier-back="true"
      >
        ‹ 换一本书
      </button>

      <p className="text-sm font-medium leading-tight text-foreground">《{source.title}》</p>

      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="学习档位" data-learn-tier-options="true">
        {TIER_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={tier === option.value}
            className={cn(
              'rounded-row border border-border bg-surface px-3 py-3 text-left transition-colors',
              tier === option.value && 'border-brand-border bg-brand-soft',
            )}
            data-learn-tier-option={option.value}
            onClick={() => onSelectTier(option.value)}
          >
            <span className="block text-sm font-medium leading-tight text-foreground">{option.title}</span>
            <span className="mt-1 block text-xs leading-5 text-muted-foreground">{option.body}</span>
          </button>
        ))}
      </div>

      <p className="text-xs leading-5 text-muted-foreground" data-learn-tier-estimate="true">
        {estimateLoading
          ? '正在估算……'
          : estimate?.status === 'ok'
            ? formatLearnEstimateText(estimate.approxChars)
            : estimate?.status === 'error'
              ? estimate.message
              : ''}
      </p>

      <Button type="button" disabled={!canStart} data-learn-start-trigger="true" onClick={onStart}>
        开始学习
      </Button>
    </section>
  )
}

/**
 * 进行中页：当前进度 message + 后台提示 + 停止。
 * `cancelling`：点了停止之后到 session 清空之前的这段秒级窗口（rewriteCardBody 进行中不会被打断，
 * 取消不是瞬时的）——按钮立刻转禁用态 + 「正在停止…」，诚实反馈，不让用户以为没点上而连点。
 * export 原因同 `LearnDoneStep`：纯展示型子组件，SSR 断言按钮禁用态/文案（follow-up C）。
 */
export function LearnRunningStep({
  message,
  cancelling,
  onCancel,
}: {
  message: string
  cancelling: boolean
  onCancel: () => void
}) {
  return (
    <section
      className="flex flex-col items-center justify-center gap-3 rounded-row border border-dashed border-border px-4 py-12 text-center"
      data-learn-running-step="true"
    >
      <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
      <p className="text-sm leading-6 text-foreground" data-learn-running-message="true">
        {message}
      </p>
      <p className={EMPTY_PRIMARY_BODY_CLASS}>学习在后台进行，你可以先去别处，完成后来『我的创作』看结果</p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={cancelling}
        data-learn-cancel-trigger="true"
        onClick={onCancel}
      >
        {cancelling ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            正在停止…
          </>
        ) : (
          '停止'
        )}
      </Button>
    </section>
  )
}

/**
 * 完成页：report 概要 + 主按钮「打开草稿工程」+ 次级「再学一本」（回选源页，不清刚学完的草稿）。
 * export：供 `.test.tsx` 用 `renderToStaticMarkup` 直接按 props 断言（评审修复波 #2）——本仓库
 * 真实 DOM interactions 测试（happy-dom + GlobalRegistrator）实测同进程内安全共存上限为 3 个既有
 * 文件（见 CharacterStatePanel.test.tsx 566 行附近的记录，追加第 4 个会让 StateChangesLedger 的
 * 18 个真实 DOM 用例全灭），本文件不再挤这个名额；纯展示型子组件改走 SSR 断言 + 独立 props 驱动。
 */
export function LearnDoneStep({
  report,
  onOpenDraft,
  onLearnAnother,
}: {
  report: PackLearnReport
  onOpenDraft: () => void
  onLearnAnother: () => void
}) {
  return (
    <section
      className="flex flex-col items-center justify-center gap-2 rounded-row border border-dashed border-border px-4 py-12 text-center"
      data-learn-done-step="true"
    >
      <h2 className={EMPTY_PRIMARY_TITLE_CLASS}>留下 {report.cardsKept} 张卡</h2>
      {report.cardsDropped > 0 ? (
        <p className={EMPTY_PRIMARY_BODY_CLASS}>有 {report.cardsDropped} 张卡质量不过关（写法太贴原文或格式不完整），已放弃</p>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <Button type="button" data-learn-open-draft-trigger="true" onClick={onOpenDraft}>
          打开草稿工程
        </Button>
        <Button type="button" variant="secondary" data-learn-done-learn-another="true" onClick={onLearnAnother}>
          再学一本
        </Button>
      </div>
    </section>
  )
}

/**
 * 失败页：message + 主动作「重试」（原源原档重跑）+ 次级「再学一本」（回选源页，session 清空但不动
 * 任何已落盘的草稿）。`primaryLabel`/`onPrimary` 保留可空签名——当前唯一调用方是失败态（恒传
 * `primaryLabel="重试"`），历史上还曾用于「已停止」终态页（无重试对象、只传 `primaryLabel: null`）；
 * 该终态页已删除（产品裁决 follow-up C：cancelled 由 store 直接清空 session，不再落进一屏确认页），
 * 组件签名原样保留，不为已消失的调用方单独收窄类型。export 原因同 `LearnDoneStep`。
 */
export function LearnEndedStep({
  message,
  primaryLabel,
  onPrimary,
  onLearnAnother,
}: {
  message: string
  primaryLabel: string | null
  onPrimary: (() => void) | null
  onLearnAnother: () => void
}) {
  return (
    <section
      className="flex flex-col items-center justify-center gap-2 rounded-row border border-dashed border-border px-4 py-12 text-center"
      data-learn-ended-step="true"
    >
      <p className={EMPTY_PRIMARY_BODY_CLASS}>{message}</p>
      <div className="mt-3 flex items-center gap-2">
        {primaryLabel && onPrimary ? (
          <Button type="button" data-learn-ended-primary="true" onClick={onPrimary}>
            {primaryLabel}
          </Button>
        ) : null}
        <Button
          type="button"
          variant={primaryLabel ? 'secondary' : 'default'}
          data-learn-ended-learn-another="true"
          onClick={onLearnAnother}
        >
          再学一本
        </Button>
      </div>
    </section>
  )
}
