// 提问卡的真实 DOM 回归（PR #77 评审复现）：提交 A 超时 → 用户改选 B → B 被主进程拒（同一问题只消费一次）
// → A 落盘、part 变 complete 且 answers=A → 卡片必须高亮 A，不能还停在本地草稿 B。
//
// happy-dom 全局注册必须先于 @testing-library/react 的加载，沿用 AgentThreadView.interactions.test.tsx 的
// 「先 register() 再顶层 await import()」写法；查询一律用 container，不用 screen（进程级单例陷阱）。
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test')

// 组件走 @/lib/ipc 的 answerAgentQuestion：照 use-planned-state-counts 的套路 mock.module 展开真实模块，
// 只覆写本文件关心的导出——bun 的 mock.module 是进程级的，不展开会剥掉其它导出炸掉同进程别的文件。
const answerAgentQuestionMock = mock(async () => ({ accepted: true }))
const actualIpc = await import('@/lib/ipc')
mock.module('@/lib/ipc', () => ({ ...actualIpc, answerAgentQuestion: answerAgentQuestionMock }))

const { act, cleanup, fireEvent, render } = await import('@testing-library/react')
const { AgentQuestionCard } = await import('./AgentQuestionCard')
type AgentMessagePart = import('@shared/types/agent').AgentMessagePart
type QuestionPart = Extract<AgentMessagePart, { type: 'question' }>

const QUESTION = '关于什么？'

function part(overrides: Partial<QuestionPart> = {}): QuestionPart {
  return {
    id: 'part-q-1',
    type: 'question',
    questionRequestId: 'q-1',
    toolCallId: 'q-1',
    status: 'running',
    questions: [
      {
        header: '概念',
        question: QUESTION,
        options: [
          { label: 'A', description: 'a' },
          { label: 'B', description: 'b' },
        ],
      },
    ],
    ...overrides,
  }
}

function optionButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')).find((item) =>
    item.textContent?.includes(label),
  )
  if (!button) throw new Error(`找不到选项 ${label}`)
  return button
}

afterEach(() => {
  cleanup()
})

afterAll(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await GlobalRegistrator.unregister()
})

describe('AgentQuestionCard 完成态答案（真实 DOM）', () => {
  test('本地草稿选了 B，part 完成且答案是 A → 卡片高亮 A、显示「已提交选择」', async () => {
    const view = render(<AgentQuestionCard part={part()} />)
    await act(async () => {
      fireEvent.click(optionButton(view.container, 'B'))
    })
    expect(optionButton(view.container, 'B').getAttribute('aria-pressed')).toBe('true')
    expect(optionButton(view.container, 'A').getAttribute('aria-pressed')).toBe('false')

    // 主进程只收下了 A（第一次提交），question.answered 事件把 part 收口成 complete + answers=A
    view.rerender(<AgentQuestionCard part={part({ status: 'complete', answers: { [QUESTION]: 'A' } })} />)
    expect(optionButton(view.container, 'A').getAttribute('aria-pressed')).toBe('true')
    expect(optionButton(view.container, 'B').getAttribute('aria-pressed')).toBe('false')
    expect(view.container.textContent).toContain('已提交选择')
  })

  test('运行中：本地草稿照常可改（完成态覆盖只在 complete 时生效）', async () => {
    const view = render(<AgentQuestionCard part={part()} />)
    await act(async () => {
      fireEvent.click(optionButton(view.container, 'A'))
    })
    await act(async () => {
      fireEvent.click(optionButton(view.container, 'B'))
    })
    expect(optionButton(view.container, 'B').getAttribute('aria-pressed')).toBe('true')
    expect(optionButton(view.container, 'A').getAttribute('aria-pressed')).toBe('false')
  })
})
