import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AgentQuestionCard,
  parseStoredAnswer,
  resolveQuestionTabLabels,
  serializeAnswerState,
  isSubmitTimeoutError,
  QUESTION_SUBMIT_TIMEOUT_MS,
  withSubmitTimeout,
} from './AgentQuestionCard'
import type { AgentMessagePart, AgentQuestion } from '@shared/types/agent'

type QuestionPart = Extract<AgentMessagePart, { type: 'question' }>

function questionPart(overrides: Partial<QuestionPart> = {}): QuestionPart {
  return {
    id: 'part-1',
    type: 'question',
    questionRequestId: 'q-1',
    toolCallId: 'tool-1',
    status: 'running',
    questions: [
      {
        header: '走向',
        question: '主角接下来公开还是隐藏身份？',
        options: [
          { label: '公开', description: '推进正面对抗' },
          { label: '隐藏', description: '保留悬念' },
        ],
      },
      {
        header: '基调',
        question: '本章的情绪基调是什么？',
        options: [
          { label: '紧张', description: '快节奏推进' },
          { label: '舒缓', description: '留白沉淀' },
        ],
      },
    ],
    ...overrides,
  }
}

describe('AgentQuestionCard', () => {
  test('renders multiple questions as a single tabbed card', () => {
    const html = renderToStaticMarkup(<AgentQuestionCard part={questionPart()} />)

    expect(html).toContain('data-agent-question-tabs="true"')
    expect(html).toContain('data-agent-question-tab="0"')
    expect(html).toContain('data-agent-question-tab="1"')
    // 默认停在第一题
    expect(html).toContain('主角接下来公开还是隐藏身份？')
    // 有上一题 / 下一题导航
    expect(html).toContain('上一题')
    expect(html).toContain('下一题')
    // 第一题不是最后一题，提交按钮只在最后一题出现
    expect(html).not.toContain('提交选择')
  })

  test('marks answered questions on their tab', () => {
    const html = renderToStaticMarkup(
      <AgentQuestionCard part={questionPart({ answers: { '主角接下来公开还是隐藏身份？': '公开' } })} />,
    )

    expect(html).toMatch(/data-agent-question-tab="0"[^>]*data-answered="true"/)
    expect(html).toMatch(/data-agent-question-tab="1"[^>]*data-answered="false"/)
  })

  test('renders a single question without tabs and shows submit immediately', () => {
    const base = questionPart()
    const singlePart: QuestionPart = { ...base, questions: [base.questions[0]] }
    const html = renderToStaticMarkup(<AgentQuestionCard part={singlePart} />)

    expect(html).not.toContain('data-agent-question-tabs')
    expect(html).not.toContain('上一题')
    expect(html).toContain('提交选择')
  })

  test('renders numeric tab labels when question headers are duplicated', () => {
    const base = questionPart()
    const dupPart: QuestionPart = {
      ...base,
      questions: [
        { ...base.questions[0], header: '走向' },
        { ...base.questions[1], header: '走向' },
      ],
    }
    const html = renderToStaticMarkup(<AgentQuestionCard part={dupPart} />)

    expect(html).toContain('问题 1')
    expect(html).toContain('问题 2')
  })
})

const COMMA_LABEL_QUESTION: AgentQuestion = {
  header: '每章字数',
  question: '每章字数目标？',
  options: [
    { label: '[2000, 2500]（短章快更）', description: '网文快节奏' },
    { label: '[3000, 4000]（中等篇幅）', description: '主流选择' },
    { label: '[4000, 6000]（长章慢节奏）', description: '文学向' },
  ],
}

describe('AgentQuestionCard with comma-containing labels', () => {
  test('restores a stored comma label as a selected preset, not custom text', () => {
    const base = questionPart()
    const singlePart: QuestionPart = {
      ...base,
      questions: [COMMA_LABEL_QUESTION],
      answers: { '每章字数目标？': '[3000, 4000]（中等篇幅）' },
    }
    const html = renderToStaticMarkup(<AgentQuestionCard part={singlePart} />)

    // 选项高亮：含逗号的 label 整体匹配，不被逗号分割
    expect(html).toContain('aria-pressed="true"')
    // 自定义回答框保持为空，不回填选项文案
    expect(html).not.toMatch(/<textarea[^>]*>\[3000, 4000\]/)
  })

  test('keeps genuine custom answers in the custom textarea', () => {
    const base = questionPart()
    const singlePart: QuestionPart = {
      ...base,
      questions: [COMMA_LABEL_QUESTION],
      answers: { '每章字数目标？': '每章 5500 字左右' },
    }
    const html = renderToStaticMarkup(<AgentQuestionCard part={singlePart} />)

    expect(html).not.toContain('aria-pressed="true"')
    expect(html).toMatch(/<textarea[^>]*>每章 5500 字左右<\/textarea>/)
  })
})

describe('parseStoredAnswer / serializeAnswerState', () => {
  test('parses a single-select comma label as one selection', () => {
    expect(parseStoredAnswer('[3000, 4000]（中等篇幅）', COMMA_LABEL_QUESTION)).toEqual({
      selected: ['[3000, 4000]（中等篇幅）'],
      custom: '',
    })
  })

  test('decomposes multi-select joined comma labels with backtracking', () => {
    const multi: AgentQuestion = { ...COMMA_LABEL_QUESTION, multiSelect: true }
    expect(
      parseStoredAnswer('[2000, 2500]（短章快更）, [3000, 4000]（中等篇幅）', multi),
    ).toEqual({
      selected: ['[2000, 2500]（短章快更）', '[3000, 4000]（中等篇幅）'],
      custom: '',
    })
  })

  test('falls back to custom text when the value matches no option', () => {
    expect(parseStoredAnswer('每章 5500 字左右', COMMA_LABEL_QUESTION)).toEqual({
      selected: [],
      custom: '每章 5500 字左右',
    })
  })

  test('serializes custom text first, then joined selections', () => {
    expect(serializeAnswerState({ selected: [], custom: ' 自定义 ' })).toBe('自定义')
    expect(
      serializeAnswerState({ selected: ['[2000, 2500]（短章快更）', '[3000, 4000]（中等篇幅）'], custom: '' }),
    ).toBe('[2000, 2500]（短章快更）, [3000, 4000]（中等篇幅）')
  })
})

describe('resolveQuestionTabLabels', () => {
  test('uses unique non-empty headers as labels', () => {
    expect(
      resolveQuestionTabLabels([
        { header: '走向', question: 'q1', options: [] },
        { header: '基调', question: 'q2', options: [] },
      ]),
    ).toEqual(['走向', '基调'])
  })

  test('falls back to numeric labels for empty or duplicated headers', () => {
    expect(
      resolveQuestionTabLabels([
        { header: '走向', question: 'q1', options: [] },
        { header: '走向', question: 'q2', options: [] },
        { header: '', question: 'q3', options: [] },
      ]),
    ).toEqual(['问题 1', '问题 2', '问题 3'])
  })
})

describe('withSubmitTimeout（提交超时兜底）', () => {
  test('主进程在限时内回复：结果原样透传', async () => {
    await expect(withSubmitTimeout(Promise.resolve({ accepted: true }), 50)).resolves.toEqual({ accepted: true })
  })

  test('主进程一直不回（磁盘被锁）：限时后抛 SubmitTimeoutError，按钮才有机会复位', async () => {
    const never = new Promise<never>(() => {})
    const error = await withSubmitTimeout(never, 10).catch((e: unknown) => e)
    expect(isSubmitTimeoutError(error)).toBe(true)
    // 普通 Error + code，不是 class（AGENTS.md 约束）
    expect(error).toBeInstanceOf(Error)
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype)
  })

  test('主进程报错：原错误冒泡，不被包成超时', async () => {
    const error = await withSubmitTimeout(Promise.reject(new Error('问题已过期')), 50).catch((e: unknown) => e)
    expect((error as Error).message).toBe('问题已过期')
    expect(isSubmitTimeoutError(error)).toBe(false)
  })

  test('默认限时 15 秒——比正常路径（几十毫秒）长两个数量级，不会误伤慢机器', () => {
    expect(QUESTION_SUBMIT_TIMEOUT_MS).toBe(15_000)
  })
})
