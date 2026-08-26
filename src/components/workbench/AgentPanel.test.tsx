import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentPanel, AgentPanelContent, getAgentStepsTogglePresentation, isNewConversationDisabled } from './AgentPanel'
import { createEmptyAgentThread, reduceAgentEvent } from '@/lib/agent-events'
import { useAgentStore } from '@/lib/agent-store'
import type { AgentEvent, AgentThread } from '@shared/types/agent'

// AgentPanel → AgentComposer 底栏挂了 AgentModelSwitcher（切片②T3），其 useNavigate 需要 Router
// 上下文，所有 SSR 快照都套一层 MemoryRouter，否则抛「useNavigate() may be used only in the
// context of a <Router> component」。
beforeEach(() => {
  useAgentStore.getState().resetAgentState()
})

describe('AgentPanel', () => {
  test('exports a component', () => {
    expect(typeof AgentPanel).toBe('function')
  })

  test('renders as a side-only panel without layout toggle controls', () => {
    const html = renderToStaticMarkup(<TooltipProvider>
      <MemoryRouter><AgentPanel /></MemoryRouter>
    </TooltipProvider>)

    expect(html).not.toContain('展开步骤')
    expect(html).not.toContain('切换到侧边对话')
    expect(html).not.toContain('退出侧边对话')
    expect(html).not.toContain('写作操作台')
    expect(html).not.toContain('自然语言对话仍然可用')
    expect(html).not.toContain('pointer-events-auto absolute')
    expect(html).not.toContain('mx-8 -mb-px')
    expect(html).not.toContain('data-agent-panel-tabs="true"')
    expect(html).not.toContain('role="tablist"')
    expect(html).not.toContain('role="tabpanel"')
  })

  test('lets the Agent titlebar drag the frameless window without swallowing controls', () => {
    const thread = ([
      {
        type: 'run.started',
        runId: 'run-1',
        threadId: 'thread-1',
        command: 'write-next',
        prompt: '继续写下一章',
        createdAt: '2026-04-27T00:00:00.000Z',
      },
      {
        type: 'task-plan.updated',
        runId: 'run-1',
        items: [{ id: 'task-1', title: '读取现有设定', status: 'running' }],
        createdAt: '2026-04-27T00:00:01.000Z',
      },
    ] satisfies AgentEvent[]).reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    const html = renderToStaticMarkup(
      <TooltipProvider>
      <MemoryRouter>
        <AgentPanelContent thread={thread} />
      </MemoryRouter>
    </TooltipProvider>,
    )

    expect(html).toContain('data-agent-panel-titlebar="true"')
    expect(html).toContain('[-webkit-app-region:drag]')
    expect(html).toContain('[-webkit-app-region:no-drag]')
  })

  test('pins the header actions to the card edge now that the caption band sits above the card', () => {
    // 方案 A（上下分区）后 Agent 面板头部在 caption 带下方，右缘不再需要
    // --titlebar-inset-right 让位——保留会把「新对话」按钮推离卡片右缘 145px（排版 bug）。
    const source = readFileSync(fileURLToPath(new URL('./AgentPanel.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('pl-[0.875rem] pr-[0.875rem]')
    expect(source).not.toContain('pr-[max(0.875rem,var(--titlebar-inset-right))]')
  })

  test('does not show the task plan expansion control for ordinary tool activity', () => {
    const thread = ([
      {
        type: 'run.started',
        runId: 'run-1',
        threadId: 'thread-1',
        command: 'write-next',
        prompt: '继续写下一章',
        createdAt: '2026-04-27T00:00:00.000Z',
      },
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'tool-1',
        toolName: 'NarraCat',
        title: '准备上下文包',
        createdAt: '2026-04-27T00:00:01.000Z',
      },
    ] satisfies AgentEvent[]).reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    const html = renderToStaticMarkup(
      <TooltipProvider>
      <MemoryRouter>
        <AgentPanelContent thread={thread} />
      </MemoryRouter>
    </TooltipProvider>,
    )

    expect(html).not.toContain('展开步骤')
    expect(html).not.toContain('1 步')
    expect(html).not.toContain('写作操作台')
    expect(html).not.toContain('mx-8 -mb-px')
    expect(html).toContain('p-3 pt-2')
    expect(html).not.toContain('p-3 pt-0')
  })

  test('shows the task plan expansion control only when the current run has a task plan', () => {
    const thread = ([
      {
        type: 'run.started',
        runId: 'run-1',
        threadId: 'thread-1',
        command: 'write-next',
        prompt: '继续写下一章',
        createdAt: '2026-04-27T00:00:00.000Z',
      },
      {
        type: 'task-plan.updated',
        runId: 'run-1',
        items: [
          { id: 'task-1', title: '读取现有设定', status: 'complete' },
          { id: 'task-2', title: '生成风格指南', status: 'running' },
        ],
        createdAt: '2026-04-27T00:00:01.000Z',
      },
    ] satisfies AgentEvent[]).reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    const html = renderToStaticMarkup(
      <TooltipProvider>
      <MemoryRouter>
        <AgentPanelContent thread={thread} />
      </MemoryRouter>
    </TooltipProvider>,
    )

    expect(html).toContain('h-14')
    expect(html).toContain('展开执行步骤')
    expect(html).toContain('data-icon-tooltip="展开执行步骤"')
    expect(html).toContain('data-agent-steps-toggle-icon="down"')
    expect(html).toContain('lucide-chevron-down')
    expect(html).not.toContain('lucide-chevron-up')
    expect(html).not.toContain('title="展开执行步骤"')
    expect(html).toContain('2 / 2 · 生成风格指南')
    expect(html).not.toContain('收起执行步骤')
    expect(html).not.toContain('写作操作台')
  })

  test('uses down-to-open and up-to-collapse semantics for the steps toggle', () => {
    expect(getAgentStepsTogglePresentation(false)).toEqual({
      iconDirection: 'down',
      label: '展开执行步骤',
    })
    expect(getAgentStepsTogglePresentation(true)).toEqual({
      iconDirection: 'up',
      label: '收起执行步骤',
    })
  })

  test('keeps the side composer embedded when the steps panel is hidden', () => {
    const html = renderToStaticMarkup(<TooltipProvider>
      <MemoryRouter><AgentPanel /></MemoryRouter>
    </TooltipProvider>)

    expect(html).toContain('p-3 pt-2')
    expect(html).not.toContain('p-3 pt-0')
    expect(html).toContain('向 Agent 描述任务')
    expect(html).not.toContain('写作指令')
  })

  test('uses the elevated composer shadow in the side panel', () => {
    const html = renderToStaticMarkup(<TooltipProvider>
      <MemoryRouter><AgentPanel /></MemoryRouter>
    </TooltipProvider>)

    expect(html).toContain('shadow-[var(--shadow-floating)]')
  })

  test('keeps the composer in flow (not an overlay) while collapsed by default', () => {
    const html = renderToStaticMarkup(<TooltipProvider>
      <MemoryRouter><AgentPanel /></MemoryRouter>
    </TooltipProvider>)

    // 折叠态：输入框在流内，不是底部浮层
    expect(html).toContain('向 Agent 描述任务')
    expect(html).not.toContain('absolute inset-x-0 bottom-0')
  })

  test('turns the composer into a bottom overlay when expanded so history does not reflow', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentPanel.tsx', import.meta.url)), 'utf-8')

    // 展开时输入框转为底部浮层，覆盖历史而非挤压
    expect(source).toContain('onExpandedChange={setComposerExpanded}')
    expect(source).toContain("composerExpanded ? 'absolute inset-x-0 bottom-0' : 'relative'")
    // 留等高占位，历史区高度不变、插图不挪动
    expect(source).toContain('style={{ height: collapsedComposerHeight }}')
    // 折叠态量取真实高度（SSR/jsdom 守卫）
    expect(source).toContain('if (!composerExpanded) setCollapsedComposerHeight(el.offsetHeight)')
    expect(source).toContain("typeof ResizeObserver === 'undefined'")
  })

  test('isNewConversationDisabled gates on empty / running thread', () => {
    expect(isNewConversationDisabled(undefined)).toBe(true)
    const empty: AgentThread = { id: 't', messages: [], activeRun: null, lastRun: null }
    expect(isNewConversationDisabled(empty)).toBe(true)
    const running: AgentThread = {
      id: 't',
      messages: [{ id: 'u', role: 'user', createdAt: 'x', status: 'complete', parts: [] }],
      activeRun: { id: 'r', threadId: 't', command: 'freeform', prompt: 'p', status: 'running', startedAt: 'x' },
      lastRun: null,
    }
    expect(isNewConversationDisabled(running)).toBe(true)
    const ready: AgentThread = {
      id: 't',
      messages: [{ id: 'u', role: 'user', createdAt: 'x', status: 'complete', parts: [] }],
      activeRun: null,
      lastRun: null,
    }
    expect(isNewConversationDisabled(ready)).toBe(false)
  })

  test('renders the new-conversation button in the panel header', () => {
    const thread: AgentThread = {
      id: 't',
      messages: [{ id: 'u', role: 'user', createdAt: 'x', status: 'complete', parts: [] }],
      activeRun: null,
      lastRun: null,
    }
    const html = renderToStaticMarkup(
      <TooltipProvider>
      <MemoryRouter>
        <AgentPanelContent thread={thread} threadId="t" />
      </MemoryRouter>
    </TooltipProvider>
    )
    expect(html).toContain('data-agent-new-conversation="true"')
  })

  test('offers recover-write after loading an interrupted write segment', () => {
    const thread = ([
      {
        type: 'run.started',
        runId: 'run-1',
        threadId: 'thread-1',
        command: 'write-next',
        prompt: '写第 3 章',
        projectPath: '/novels/stars',
        selectedChapter: 3,
        createdAt: '2026-04-27T00:00:00.000Z',
      },
      {
        type: 'run.interrupted',
        runId: 'run-1',
        error: 'App restarted',
        createdAt: '2026-04-27T00:00:01.000Z',
      },
    ] satisfies AgentEvent[]).reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    const html = renderToStaticMarkup(
      <TooltipProvider>
      <MemoryRouter>
        <AgentPanelContent thread={thread} threadId="thread-1" />
      </MemoryRouter>
    </TooltipProvider>,
    )

    expect(html).toContain('data-agent-panel-tabs="true"')
    expect(html).toContain('aria-label="Agent 面板视图"')
    expect(html).toContain('role="tablist"')
    expect(html.match(/role="tab"/g)).toHaveLength(2)
    expect(html.match(/role="tabpanel"/g)).toHaveLength(2)
    expect(html).toContain('>对话<')
    expect(html).toContain('>进度<')
    expect(html).toContain('data-agent-panel-view="conversation"')
    expect(html).toContain('data-agent-panel-view="progress"')
    expect(html).toContain('继续完成本章')
    expect(html).not.toContain('>重试<')
  })

  test('offers check-and-continue for another interrupted project mutation', () => {
    const thread = ([
      {
        type: 'run.started',
        runId: 'run-1',
        threadId: 'thread-1',
        command: 'world',
        prompt: '完善世界观',
        projectPath: '/novels/stars',
        createdAt: '2026-04-27T00:00:00.000Z',
      },
      {
        type: 'run.interrupted',
        runId: 'run-1',
        error: 'App restarted',
        createdAt: '2026-04-27T00:00:01.000Z',
      },
    ] satisfies AgentEvent[]).reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    const html = renderToStaticMarkup(
      <TooltipProvider>
      <MemoryRouter>
        <AgentPanelContent thread={thread} threadId="thread-1" />
      </MemoryRouter>
    </TooltipProvider>,
    )

    expect(html).toContain('检查并继续')
  })

  test('keeps the new-conversation confirm dialog closed by default', () => {
    const thread: AgentThread = {
      id: 't',
      messages: [{ id: 'u', role: 'user', createdAt: 'x', status: 'complete', parts: [] }],
      activeRun: null,
      lastRun: null,
    }
    const html = renderToStaticMarkup(
      <TooltipProvider>
      <MemoryRouter>
        <AgentPanelContent thread={thread} threadId="t" />
      </MemoryRouter>
    </TooltipProvider>
    )
    // Radix Dialog closed 时 portal 内容不渲染：确认弹窗默认不弹
    expect(html).not.toContain('开始新对话？')
    expect(html).not.toContain('AI 将不再记得上面的聊天')
  })

  test('shows the run elapsed timer in the header while a run is active (stop stays on the composer button)', () => {
    const thread = ([
      {
        type: 'run.started',
        runId: 'run-1',
        threadId: 'thread-1',
        command: 'write-next',
        prompt: '继续写下一章',
        createdAt: '2026-04-27T00:00:00.000Z',
      },
    ] satisfies AgentEvent[]).reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))

    const html = renderToStaticMarkup(
      <TooltipProvider>
      <MemoryRouter>
        <AgentPanelContent thread={thread} />
      </MemoryRouter>
    </TooltipProvider>,
    )

    expect(html).toContain('data-agent-run-elapsed="true"')
    // 停止入口只保留输入框发送键（运行时变 ■），头部不再放第二个停止按钮（2026-07-07 用户验收反馈）
    expect(html).not.toContain('data-agent-header-stop')
  })

  test('hides the run elapsed timer when there is no active run', () => {
    const thread: AgentThread = {
      id: 't',
      messages: [{ id: 'u', role: 'user', createdAt: 'x', status: 'complete', parts: [] }],
      activeRun: null,
      lastRun: null,
    }
    const html = renderToStaticMarkup(
      <TooltipProvider>
      <MemoryRouter>
        <AgentPanelContent thread={thread} threadId="t" />
      </MemoryRouter>
    </TooltipProvider>,
    )

    expect(html).not.toContain('data-agent-run-elapsed="true"')
  })

  test('gates the new conversation behind a confirm step (click opens dialog, confirm runs the effects)', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentPanel.tsx', import.meta.url)), 'utf-8')
    // 点按钮只打开确认弹窗，不直接执行破坏性动作
    expect(source).toContain('setConfirmNewConversationOpen(true)')
    // 确认后只调用主进程原子命令，并用返回 snapshot 替换本地投影
    expect(source).toContain('await startNewAgentConversation({')
    expect(source).toContain('replaceThreadFromSnapshot(snapshot)')
    expect(source).toContain('setConfirmNewConversationOpen(false)')
    expect(source).not.toContain('forgetAgentSession(scopedThreadId)')
    expect(source).not.toContain('startNewConversation(scopedThreadId)')
  })
})
