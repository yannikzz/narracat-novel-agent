import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useConfirmDialog } from '@/components/ui/confirm-dialog'
import { POLISH_SLOT_LABELS } from './PolishSetupDialog'
import { ArtifactDocumentBody } from './ArtifactDocumentShell'
import {
  METADATA_TEXT_CLASS,
  READING_BODY_FONT_CLASS,
  WORKBENCH_READING_CANVAS_CLASS,
} from '@/design-system'
import { cn } from '@/lib/cn'
import { adoptPolishedChapter, getPolishSettings, markStandingPromptAnswered, setStandingPolishSlot } from '@/lib/ipc'
import { diffManuscriptRevision } from '@/lib/manuscript-revision-diff'
import { formatPolishElapsed, isPolishVersionRunning, usePolishRun } from '@/lib/polish-store'
import { describePolishDrift } from '@shared/lib/prose-polish-drift'
import type { PolishSlotId, PolishVersionState } from '@shared/types/prose-polish'

/**
 * 润色版本在正文内容区的呈现（ADR-0041 §10）。
 *
 * 版本活在正文页而不是抽屉里：作者判断润色好坏的方式是「读起来顺不顺」，那需要整章沉浸阅读，
 * 就在他平时读这本书的那块地方读。tab 排在章节视图 tab 之下，与它同一套视觉语言。
 *
 * **排版必须与原稿逐项一致**：同一个 820px 阅读栏、同一个 `MarkdownRenderer`（经
 * `ArtifactDocumentBody`）。宽度或段距差一点，作者对比两版时读到的差异里就掺进了排版差异，
 * 而他要判断的是文字本身。
 *
 * **所有操作收在正文上方那一条**（含「丢弃」）——tab 行只切换视图，不承载动作，
 * 否则同一屏会出现两个操作区，作者得记住哪个按钮在哪儿。
 *
 * 采用之前正文文件一个字节都没变。版本只活在本次会话里，但**不随离开页面或切章消失**——
 * 归属由 `projectPath + chapter` 判定，清空只由「丢弃 / 采用 / 发起新一轮」触发。
 */

export type PolishTabValue = 'original' | PolishSlotId

/** 与正文阅读画布同宽同居中：操作条的左右边缘必须和正文对齐，否则一眼就看出是两套东西。 */
const POLISH_READING_COLUMN_CLASS = 'mx-auto w-full max-w-[820px]'

/**
 * 每秒走一下的计时。
 *
 * 开着推理模式时模型可能长时间只吐思考、不吐正文（实测过整章零产出），没有这个计时，界面
 * 在那段时间里看起来就是死的——真机上作者据此判断功能坏了。
 */
function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** 段落级改动比例：完全一致的段落之外都算改过。 */
export function changedParagraphRatio(original: string, polished: string): number {
  const lines = original
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return 0
  const polishedLines = new Set(
    polished
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )
  const unchanged = lines.filter((line) => polishedLines.has(line)).length
  return (lines.length - unchanged) / lines.length
}

/**
 * 一版的全部界面判断收在这里。
 *
 * 之前标签、忙碌点、三个按钮、正文分支各判各的 `status`，加一个状态就要改五处、漏一处
 * 就是一个只在某个状态下出现的怪 bug。派生一次，各处只读结果。
 */
export interface PolishVersionView {
  label: string
  /** 全文已到齐（定稿走 markdown 渲染、可对照原稿；流式期间只能纯文本） */
  complete: boolean
  canAbort: boolean
  canCompare: boolean
  canAdopt: boolean
  error: string | null
}

export function derivePolishVersionView(input: {
  version: PolishVersionState | undefined
  elapsed: string
  originalText: string
  /** 正文在这一版跑完之后又被改过——基线已经对不上，采用只会撞乐观锁。 */
  stale: boolean
}): PolishVersionView {
  const { version, elapsed, originalText, stale } = input
  const idle = { complete: false, canAbort: false, canCompare: false, canAdopt: false, error: null }
  if (!version) return { label: '', ...idle }

  switch (version.status) {
    case 'pending':
      // 「排队中」是错的：请求早发出去了，我们在等模型开口。说清楚在等，并让人看见它还在走。
      return { label: `正在生成…${elapsed}`, ...idle, canAbort: true }
    case 'streaming':
      return { label: `正在写…已出 ${version.text.length} 字`, ...idle, canAbort: true }
    case 'failed':
      return { label: '没跑成', ...idle, error: version.error ?? '没跑成' }
    case 'aborted':
      return { label: '已中止', ...idle }
    case 'done': {
      // 改动比例是这个功能最该告诉作者的一个数：一版几乎没动时，沉浸读完只会觉得「好像还行」，
      // 而他真正要知道的是「我的要求根本没落地」，不必读三千字就能判断要不要改提示词。
      const changed = Math.round(changedParagraphRatio(originalText, version.text) * 100)
      const drift = version.drift ? describePolishDrift(version.drift) : ''
      return {
        label: `改动 ${changed}% 段落 · ${drift}`,
        ...idle,
        complete: true,
        canCompare: true,
        canAdopt: !stale && version.text.trim().length > 0,
      }
    }
  }
}

/** 版本切换条：只切视图，不放任何动作。 */
export function PolishVersionTabs({
  active,
  onChange,
}: {
  active: PolishTabValue
  onChange: (value: PolishTabValue) => void
}) {
  const order = usePolishRun((state) => state.order)
  const versions = usePolishRun((state) => state.versions)

  const items: Array<{ value: PolishTabValue; label: string; busy: boolean }> = [
    { value: 'original', label: '原稿', busy: false },
    ...order.map((slotId) => ({
      value: slotId as PolishTabValue,
      label: POLISH_SLOT_LABELS[slotId],
      busy: isPolishVersionRunning(versions[slotId]),
    })),
  ]

  return (
    <div
      className={cn(POLISH_READING_COLUMN_CLASS, 'mb-3 flex items-center justify-center gap-1.5')}
      data-polish-version-tabs="true"
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          data-active={item.value === active}
          aria-current={item.value === active ? 'true' : undefined}
          className={cn(
            'flex h-7 shrink-0 items-center gap-1.5 rounded-row px-2.5 text-xs transition-colors duration-200',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            item.value === active
              ? 'bg-active font-semibold text-foreground'
              : 'text-muted-foreground hover:bg-hover hover:text-foreground',
          )}
          onClick={() => onChange(item.value)}
        >
          <span className="truncate">{item.label}</span>
          {item.busy && <span aria-hidden="true" className="size-1.5 shrink-0 animate-pulse rounded-full bg-ring" />}
        </button>
      ))}
    </div>
  )
}

/**
 * 统一的操作与状态条 + 版本正文。
 *
 * 原稿页也渲染这一条（只留「丢弃」），这样操作区的位置在四个 tab 之间是固定的。
 */
export function PolishPanel({
  active,
  projectPath,
  chapter,
  originalText,
  stale,
  onDiscard,
  onAdopted,
}: {
  active: PolishTabValue
  projectPath: string
  chapter: number
  originalText: string
  /** 正文在这几版跑完之后又被改过——只提示不禁用的话，作者会读完才在采用时撞乐观锁。 */
  stale: boolean
  onDiscard: () => void
  onAdopted: () => void
}) {
  const [comparing, setComparing] = useState(false)
  const [adopting, setAdopting] = useState(false)
  const { confirm, confirmWithOutcome, confirmDialog } = useConfirmDialog()

  const slotId = active === 'original' ? null : active
  const version = usePolishRun((state) => (slotId ? state.versions[slotId] : undefined))
  const startedAt = usePolishRun((state) => state.startedAt)
  const order = usePolishRun((state) => state.order)
  const cancelOne = usePolishRun((state) => state.cancelOne)
  const cancelAll = usePolishRun((state) => state.cancelAll)
  const reset = usePolishRun((state) => state.reset)

  // 流式期间多走一秒计时无害（每个 delta 本来就在重渲染），换来这里不必再自己判 status。
  const now = useTick(isPolishVersionRunning(version))
  const view = derivePolishVersionView({
    version,
    elapsed: formatPolishElapsed(startedAt, now),
    originalText,
    stale,
  })

  // 必须同时判可对照：comparing 跨版本共享，开着它切到还在流的版本就会对半截文本算 diff——
  // 那个 diff 只会显示「后面全被删了」，纯属误导。
  const diff = comparing && view.canCompare && version ? diffManuscriptRevision(originalText, version.text) : null

  async function adopt(acknowledged = false): Promise<void> {
    if (!slotId || !view.canAdopt || !version) return
    setAdopting(true)
    try {
      const result = await adoptPolishedChapter({
        projectPath,
        chapter,
        slotId,
        polishedText: version.text,
        expectedVisibleText: originalText,
        divergenceAcknowledged: acknowledged,
      })

      if (!result.ok) {
        if (result.needsDivergenceAck) {
          const confirmed = await confirm({
            title: '这一版改动了情节',
            description: '旧章节的改动不会进入记忆，后续创作仍按原来的情节走。这一章的正文与记忆会从此对不上。',
            confirmLabel: '仍然采用',
          })
          if (confirmed) await adopt(true)
          return
        }
        toast.error(result.message)
        return
      }

      // 采用一版就等于放弃其余版本，**落盘那一刻就停**：常驻提议框可能开着不关，
      // 等它关了再取消，其余槽在这期间一直跑、一直烧 token。
      // 取消失败不算采用失败——正文已经落盘，报「采用失败」是撒谎；最坏只是多烧一版的钱。
      await cancelAll().catch((error) => console.error(error))

      // 采用成功不发 toast（design.md：Toast 不做操作确认）。正文当场换成这一版，
      // 需要后续动作的两种收场各有常驻的内联横条：待同步红点、正文与记忆分家标识。
      onAdopted()
      // 提议框渲染在本面板里，reset 会让面板随 polishActive 一起卸载——所以 reset 必须等它关掉。
      await proposeStanding(slotId)
      reset()
    } catch (error) {
      console.error(error)
      toast.error('采用失败，请重试')
    } finally {
      setAdopting(false)
    }
  }

  /**
   * 采用之后顺势问一次——那是作者刚做完「我信这套」判断的时刻。
   *
   * **一本书只问一次**：已经常驻了不必再问，答过「这次就好」更不该反复追问。
   * 每采用一版就弹一次，是拿一个已经被回答过的问题反复打断作者（真机反馈）。
   * 想改主意随时能在润色弹窗里改。
   */
  async function proposeStanding(adoptedSlot: PolishSlotId): Promise<void> {
    const settings = await getPolishSettings(projectPath).catch(() => null)
    // 读不到设置就不问：宁可少问一次，也不要在不知道问过没有的情况下打断作者。
    if (!settings || settings.standingPromptAnswered || settings.standingSlotId) return

    const outcome = await confirmWithOutcome({
      title: `以后这本书都用「${POLISH_SLOT_LABELS[adoptedSlot]}」润色？`,
      description: '写完新章后自动按这套要求润一遍，随时可以在润色弹窗里改。只影响往后新写的章。',
      confirmLabel: '设为常驻',
      cancelLabel: '这次就好',
    })

    // 「设为常驻」与「这次就好」都是明确回答，记下不再问；
    // 而 Esc / 点遮罩 / 关闭按钮不是回答——那是「现在不想理它」，下次该再问一次。
    if (outcome !== 'dismiss') {
      await markStandingPromptAnswered(projectPath).catch((error) => console.error(error))
    }
    if (outcome !== 'confirm') return
    await setStandingPolishSlot({ projectPath, slotId: adoptedSlot }).catch((error) => {
      console.error(error)
      toast.error('设置常驻失败')
    })
  }

  return (
    <div data-polish-panel={active}>
      {/*
        操作条随滚动置顶：读到第三屏还想「采用这版」时，不该先滚回去找按钮。
        外层负责吸附与遮罩（`bg-workspace` 挡住从上方滚过来的正文），内层保持原来的条形外观。
      */}
      <div className={cn(POLISH_READING_COLUMN_CLASS, 'sticky top-0 z-20 bg-workspace pb-3 pt-1')}>
        <div className="flex items-center justify-between gap-3 rounded-row border border-border bg-surface px-3 py-2">
          <p className={cn(METADATA_TEXT_CLASS, 'min-w-0 truncate')}>
            {slotId
              ? `${view.label}${
                  version?.usage ? ` · 用量 ${version.usage.inputTokens} / ${version.usage.outputTokens}` : ''
                }`
              : `${order.length} 版可选，切过去读读看`}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {slotId && view.canAbort && (
              <Button type="button" variant="ghost" size="sm" onClick={() => void cancelOne(slotId)}>
                中止
              </Button>
            )}
            {slotId && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setComparing((current) => !current)}
                  disabled={!view.canCompare}
                >
                  {comparing ? '读全文' : '对照原稿'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void adopt()}
                  disabled={!view.canAdopt || adopting}
                >
                  采用这版
                </Button>
              </>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={onDiscard}>
              丢弃
            </Button>
          </div>
        </div>
      </div>

      {slotId && (
        <section className={WORKBENCH_READING_CANVAS_CLASS} data-reading-canvas="true">
          {view.error ? (
            <p className="py-4 text-sm text-destructive">{view.error}</p>
          ) : diff ? (
            <div className="font-mono text-xs leading-5" data-polish-diff="true">
              {diff.lines.map((line, index) => (
                <div
                  key={`${line.type}-${line.oldLine ?? ''}-${line.newLine ?? ''}-${index}`}
                  className={cn(
                    'px-2',
                    line.type === 'added' && 'bg-success/10 text-success',
                    line.type === 'removed' && 'bg-destructive/10 text-destructive',
                    line.type === 'context' && 'text-body-foreground',
                  )}
                  data-diff-line={line.type}
                >
                  <span className="whitespace-pre-wrap break-words">{line.text || ' '}</span>
                </div>
              ))}
            </div>
          ) : view.complete && version ? (
            // 定稿走与原稿完全相同的渲染路径（ArtifactDocumentBody → MarkdownRenderer），
            // 保证两版之间的差异只来自文字本身。
            <ArtifactDocumentBody>{version.text}</ArtifactDocumentBody>
          ) : (
            // 流式期间用纯文本：每个 delta 都重新解析 markdown，一章两千多个增量会把主线程拖垮。
            // 字号/行高与 document 变体一致，切到定稿时观感不跳。
            <div
              className={cn(
                READING_BODY_FONT_CLASS,
                'min-w-0 whitespace-pre-wrap break-words leading-8 text-body-foreground',
              )}
            >
              {version?.text}
            </div>
          )}
        </section>
      )}
      {confirmDialog}
    </div>
  )
}
