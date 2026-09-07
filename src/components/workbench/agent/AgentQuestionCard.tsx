import { useState, type KeyboardEvent } from 'react'
import { Check, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { BrandIllustration } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { AGENT_QUESTION_INPUT_CLASS, AGENT_QUESTION_OPTION_CLASS, AGENT_QUESTION_TITLE_CLASS } from '@/design-system'
import { answerAgentQuestion, questionAnswerRejectedCode } from '@/lib/ipc'
import { cn } from '@/lib/cn'
import type { AgentMessagePart, AgentQuestion } from '@shared/types/agent'

type QuestionPart = Extract<AgentMessagePart, { type: 'question' }>

export interface QuestionAnswerState {
  /** 选中的预设选项 label（单选最多 1 个，多选可多个）。 */
  selected: string[]
  /** 用户手输的自定义回答；与 selected 互斥。 */
  custom: string
}

const EMPTY_ANSWER: QuestionAnswerState = { selected: [], custom: '' }

/** 提交等待上限：正常路径几十毫秒就回，15 秒还没回一定是卡在主进程那头。 */
export const QUESTION_SUBMIT_TIMEOUT_MS = 15_000

/** 超时错误不写 class（AGENTS.md 约束）：普通 Error 挂 code，用 isSubmitTimeoutError 判。 */
export const SUBMIT_TIMEOUT_CODE = 'question-submit-timeout'

export function createSubmitTimeoutError(): Error & { code: typeof SUBMIT_TIMEOUT_CODE } {
  return Object.assign(new Error('提交回答超时'), { code: SUBMIT_TIMEOUT_CODE } as const)
}

export function isSubmitTimeoutError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === SUBMIT_TIMEOUT_CODE
}

export function withSubmitTimeout<T>(operation: Promise<T>, timeoutMs = QUESTION_SUBMIT_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(createSubmitTimeoutError()), timeoutMs)
    operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function AgentQuestionCard({ part }: { part: QuestionPart }) {
  const [answers, setAnswers] = useState<Record<string, QuestionAnswerState>>(() =>
    initialAnswerStates(part.questions, part.answers),
  )
  const [submitting, setSubmitting] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const questions = part.questions
  const total = questions.length
  const isMultiQuestion = total > 1
  const clampedIndex = Math.min(Math.max(activeIndex, 0), total - 1)
  const activeQuestion = questions[clampedIndex]
  const isFirst = clampedIndex === 0
  const isLast = clampedIndex === total - 1
  const isInteractive = part.status === 'running'
  const canSubmit = isInteractive && allQuestionsAnswered(questions, answers) && !submitting
  const statusHeader = getQuestionStatusHeader(questions)
  const showQuestionHeaders = hasMultipleQuestionHeaders(questions)

  function goTo(index: number) {
    setActiveIndex(Math.min(Math.max(index, 0), total - 1))
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!isMultiQuestion) return
    // 焦点在自定义回答输入框时，左右键回归移动光标，不切换 tab。
    if (event.target instanceof HTMLElement && event.target.closest('textarea, input')) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      goTo(clampedIndex - 1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      goTo(clampedIndex + 1)
    }
  }

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      // 主进程答复要经过事件落盘；磁盘被锁（OneDrive / 杀软）时 invoke 会无限等，按钮就永远转圈。
      // 超时按失败处理并复位，让用户能再点；主进程若稍后真的收下了，question.answered 事件照样把卡片收口。
      await withSubmitTimeout(
        answerAgentQuestion({
          requestId: part.questionRequestId,
          answers: Object.fromEntries(
            questions.map((question) => [
              question.question,
              serializeAnswerState(answers[question.question] ?? EMPTY_ANSWER),
            ]),
          ),
        }),
      )
    } catch (error) {
      console.error(error)
      if (questionAnswerRejectedCode(error) === 'already-answered') {
        // 超时后再点，主进程说「刚才那次已收到、正在保存」：同一问题只消费一次，这次不算失败，
        // 按钮保持提交中，等 question.answered 事件把卡片收口（保证界面显示的就是 Agent 拿到的那份答案）。
        toast.info('刚才的提交已收到，正在保存，请稍候')
        return
      }
      toast.error(isSubmitTimeoutError(error) ? '提交没有收到回应，请重试' : '提交回答失败，请重试')
      setSubmitting(false)
    }
  }

  return (
    <div
      className={cn(
        'relative max-w-full overflow-hidden rounded-workspace border px-4 pb-4 pt-8',
        part.status === 'running'
          ? 'border-brand-border bg-[linear-gradient(145deg,var(--brand-soft)_0%,var(--workspace)_58%,var(--workspace)_100%)] shadow-[0_18px_38px_rgba(4,200,83,0.09)]'
          : 'border-border bg-surface'
      )}
      data-agent-question-card={part.questionRequestId}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      {part.status === 'running' && (
        <BrandIllustration
          purpose="agent-question"
          size="sm"
          decorative
          className="absolute right-4 top-3 size-14 opacity-95 drop-shadow-[0_8px_16px_rgba(4,200,83,0.14)]"
        />
      )}

      <div
        className={cn(
          'mb-5 flex min-w-0 flex-col items-start gap-1 text-xs font-semibold text-muted-foreground',
          part.status === 'running' && 'pr-20'
        )}
        data-agent-question-status="true"
      >
        <span className="inline-flex h-5 shrink-0 items-center justify-center rounded-row border border-brand-border bg-surface/70 px-2 text-[11px] font-semibold leading-none text-brand">
          {statusHeader}
        </span>
        <span>{part.status === 'complete' ? '已提交选择' : 'NarraCat 需要你选择'}</span>
      </div>

      {isMultiQuestion && (
        <QuestionTabs questions={questions} answers={answers} activeIndex={clampedIndex} onSelect={goTo} />
      )}

      <QuestionBlock
        key={activeQuestion.question}
        disabled={!isInteractive || submitting}
        question={activeQuestion}
        showHeader={!isMultiQuestion && showQuestionHeaders}
        value={answers[activeQuestion.question] ?? EMPTY_ANSWER}
        onChange={(value) =>
          setAnswers((current) => ({
            ...current,
            [activeQuestion.question]: value,
          }))
        }
      />

      {part.error && <div className="mt-3 text-xs text-destructive">{part.error}</div>}

      {isInteractive && (
        <div className="mt-4 flex items-center justify-between gap-2">
          {isMultiQuestion ? (
            <div className="flex items-center gap-1 text-xs text-muted-foreground" data-agent-question-nav="true">
              <Button type="button" variant="ghost" size="sm" disabled={isFirst} onClick={() => goTo(clampedIndex - 1)}>
                <ChevronLeft className="size-3.5" />
                上一题
              </Button>
              <span className="px-1 tabular-nums">
                {clampedIndex + 1} / {total}
              </span>
              <Button type="button" variant="ghost" size="sm" disabled={isLast} onClick={() => goTo(clampedIndex + 1)}>
                下一题
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
          ) : (
            <span />
          )}
          {isLast && (
            <Button type="button" size="sm" disabled={!canSubmit} onClick={() => void handleSubmit()}>
              {submitting && <Loader2 className="size-3.5 animate-spin" />}
              提交选择
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export function resolveQuestionTabLabels(questions: AgentQuestion[]): string[] {
  const headerCounts = new Map<string, number>()
  for (const question of questions) {
    const header = question.header.trim()
    if (header) headerCounts.set(header, (headerCounts.get(header) ?? 0) + 1)
  }

  // 空 header 或与其它问题重复的 header 都退化为序号，保证 tab 之间可区分。
  return questions.map((question, index) => {
    const header = question.header.trim()
    return header && headerCounts.get(header) === 1 ? header : `问题 ${index + 1}`
  })
}

function QuestionTabs({
  questions,
  answers,
  activeIndex,
  onSelect,
}: {
  questions: AgentQuestion[]
  answers: Record<string, QuestionAnswerState>
  activeIndex: number
  onSelect: (index: number) => void
}) {
  const labels = resolveQuestionTabLabels(questions)
  return (
    <div role="tablist" aria-label="问题列表" className="mb-4 flex flex-wrap gap-1.5" data-agent-question-tabs="true">
      {questions.map((question, index) => {
        const answered = isAnswered(answers[question.question])
        const active = index === activeIndex
        const label = labels[index]
        return (
          <button
            key={question.question}
            type="button"
            role="tab"
            aria-selected={active}
            title={question.question}
            className={cn(
              'inline-flex h-7 min-w-0 max-w-40 items-center gap-1.5 rounded-row border px-2.5 text-xs font-medium transition-colors',
              active
                ? 'border-brand-border bg-surface text-brand'
                : 'border-border bg-surface/60 text-muted-foreground hover:border-border-strong hover:text-foreground'
            )}
            data-agent-question-tab={index}
            data-answered={answered ? 'true' : 'false'}
            onClick={() => onSelect(index)}
          >
            {answered ? (
              <Check className="size-3 shrink-0 text-brand" aria-hidden="true" />
            ) : (
              <span className="size-1.5 shrink-0 rounded-full bg-border-strong" aria-hidden="true" />
            )}
            <span className="min-w-0 truncate">{label}</span>
          </button>
        )
      })}
    </div>
  )
}

function QuestionBlock({
  question,
  value,
  disabled,
  showHeader,
  onChange,
}: {
  question: AgentQuestion
  value: QuestionAnswerState
  disabled: boolean
  showHeader: boolean
  onChange: (value: QuestionAnswerState) => void
}) {
  // 选中态是数组 membership，与 label 内容（是否含逗号等）无关；
  // 自定义文本与预设选项互斥，点选项清自定义、手输清选项。
  function toggleOption(label: string) {
    if (!question.multiSelect) {
      onChange({ selected: [label], custom: '' })
      return
    }

    const nextSelected = value.selected.includes(label)
      ? value.selected.filter((item) => item !== label)
      : [...value.selected, label]
    onChange({ selected: nextSelected, custom: '' })
  }

  return (
    <div className="min-w-0">
      <div className="mb-3 min-w-0">
        <div className="flex min-w-0 items-start gap-2">
          {showHeader && (
            <span className="mt-0.5 inline-flex h-5 shrink-0 items-center justify-center rounded-row border border-brand-border bg-surface/70 px-2 text-[11px] font-semibold leading-none text-brand">
              {question.header}
            </span>
          )}
          <div className={cn('min-w-0 break-words leading-5 [overflow-wrap:anywhere]', AGENT_QUESTION_TITLE_CLASS)}>
            {question.question}
          </div>
        </div>
      </div>

      <div className="grid gap-2">
        {question.options.map((option) => {
          const selected = value.selected.includes(option.label)
          return (
            <button
              key={option.label}
              type="button"
              disabled={disabled}
              className={cn(
                'grid min-w-0 grid-cols-[1rem_1fr] items-start gap-2.5 rounded-row border px-3 py-2.5 text-left transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-65',
                selected
                  ? 'border-brand-border bg-surface/90 shadow-[inset_0_0_0_1px_rgba(4,200,83,0.08)]'
                  : 'border-border bg-surface/70 hover:border-border-strong hover:bg-surface'
              )}
              aria-pressed={selected}
              onClick={() => toggleOption(option.label)}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'mt-0.5 size-4 rounded-full border bg-surface',
                  selected
                    ? 'border-brand bg-[radial-gradient(circle,var(--brand)_0_35%,transparent_38%)]'
                    : 'border-border-strong'
                )}
              />
              <span className="min-w-0">
                <span className={cn('block break-words font-semibold [overflow-wrap:anywhere]', AGENT_QUESTION_OPTION_CLASS)}>
                  {option.label}
                </span>
                <span className="mt-0.5 block break-words text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
                  {option.description}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <label className="mt-3 block min-w-0">
        <span className="mb-1.5 block text-sm font-semibold text-muted-foreground">自定义回答</span>
        <Textarea
          disabled={disabled}
          value={value.custom}
          rows={2}
          className={`min-h-14 resize-none rounded-row bg-surface/70 ${AGENT_QUESTION_INPUT_CLASS}`}
          placeholder="不在选项里时，直接写你的设定"
          onChange={(event) => onChange({ selected: [], custom: event.target.value })}
        />
      </label>
    </div>
  )
}

function getQuestionStatusHeader(questions: AgentQuestion[]): string {
  const headers = uniqueQuestionHeaders(questions)
  if (headers.length === 1) return headers[0]
  return '提问'
}

function hasMultipleQuestionHeaders(questions: AgentQuestion[]): boolean {
  return uniqueQuestionHeaders(questions).length > 1
}

function uniqueQuestionHeaders(questions: AgentQuestion[]): string[] {
  return [
    ...new Set(
      questions
        .map((question) => question.header.trim())
        .filter(Boolean)
    ),
  ]
}

/** 提交/持久化序列化：自定义文本优先，否则选中 label 用 ", " 连接（与 SDK 现有 payload 约定一致）。 */
export function serializeAnswerState(state: QuestionAnswerState): string {
  const custom = state.custom.trim()
  if (custom) return custom
  return state.selected.join(', ')
}

/**
 * 从持久化的答案字符串恢复结构化状态（best-effort）：
 * - 整串等于某个选项 label → 该选项选中（含逗号的 label 不会被错误分割）
 * - 多选时尝试把整串按 ", " 精确分解为若干选项 label（带回溯，label 自身含逗号也能解出）
 * - 都不成立 → 视为自定义回答
 */
export function parseStoredAnswer(value: string, question: AgentQuestion): QuestionAnswerState {
  if (!value.trim()) return EMPTY_ANSWER

  const labels = question.options.map((option) => option.label)
  if (labels.includes(value)) return { selected: [value], custom: '' }

  if (question.multiSelect) {
    const decomposed = decomposeJoinedLabels(value, labels)
    if (decomposed) return { selected: decomposed, custom: '' }
  }

  return { selected: [], custom: value }
}

/** 把 "A, B, C" 形态的字符串精确分解为选项 label 序列；分不出则返回 null。 */
function decomposeJoinedLabels(value: string, labels: string[]): string[] | null {
  function walk(position: number): string[] | null {
    if (position === value.length) return []
    for (const label of labels) {
      if (!value.startsWith(label, position)) continue
      const next = position + label.length
      if (next === value.length) return [label]
      if (value.startsWith(', ', next)) {
        const rest = walk(next + 2)
        if (rest) return [label, ...rest]
      }
    }
    return null
  }
  return walk(0)
}

function initialAnswerStates(
  questions: AgentQuestion[],
  stored: Record<string, string> | undefined,
): Record<string, QuestionAnswerState> {
  if (!stored) return {}
  const states: Record<string, QuestionAnswerState> = {}
  for (const question of questions) {
    const value = stored[question.question]
    if (value !== undefined) states[question.question] = parseStoredAnswer(value, question)
  }
  return states
}

function isAnswered(state: QuestionAnswerState | undefined): boolean {
  return Boolean(state && serializeAnswerState(state).trim())
}

function allQuestionsAnswered(
  questions: AgentQuestion[],
  answers: Record<string, QuestionAnswerState>,
): boolean {
  return questions.every((question) => isAnswered(answers[question.question]))
}
