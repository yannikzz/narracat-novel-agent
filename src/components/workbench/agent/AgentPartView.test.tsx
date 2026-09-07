import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { AGENT_QUESTION_OPTION_CLASS } from '@/design-system'
import { AgentPartView } from './AgentPartView'
import type { AgentMessagePart } from '@shared/types/agent'

describe('AgentPartView', () => {
  test('wraps assistant text inside the available message width', () => {
    const part: AgentMessagePart = {
      id: 'text-1',
      type: 'text',
      text: '这是一个非常长的Agent回复片段with-a-very-long-token-that-should-not-force-the-panel-wider',
      status: 'running',
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} />)

    expect(html).toContain('max-w-full')
    expect(html).toContain('break-words')
    expect(html).toContain('[overflow-wrap:anywhere]')
  })

  test('renders markdown tables in assistant text output', () => {
    const part: AgentMessagePart = {
      id: 'text-2',
      type: 'text',
      text: [
        '前置检查完成：',
        '',
        '| 检查项 | 状态 |',
        '|---|---|',
        '| `.narracat/config.yaml` | ✅ 存在 |',
        '| `bible/premise.md` | 📝 空模板，可填充 |',
      ].join('\n'),
      status: 'complete',
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} />)

    expect(html).toContain('<table')
    expect(html).toContain('<th')
    expect(html).toContain('<td')
    expect(html).toContain('<code')
    expect(html).toContain('.narracat/config.yaml')
    expect(html).toContain('✅ 存在')
  })

  test('renders running assistant text with markdown table parsing', () => {
    const part: AgentMessagePart = {
      id: 'text-running',
      type: 'text',
      text: [
        '正在整理：',
        '',
        '| 检查项 | 状态 |',
        '|---|---|',
        '| 章节 | 生成中 |',
      ].join('\n'),
      status: 'running',
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} />)

    expect(html).toContain('data-agent-running-markdown="true"')
    expect(html).toContain('data-markdown-renderer="conversation"')
    expect(html).toContain('<table')
    expect(html).toContain('<th')
    expect(html).toContain('<td')
    expect(html).not.toContain('data-agent-running-text="true"')
  })

  test('renders completed assistant text with markdown parsing', () => {
    const part: AgentMessagePart = {
      id: 'text-complete',
      type: 'text',
      text: [
        '整理完成：',
        '',
        '| 检查项 | 状态 |',
        '|---|---|',
        '| 章节 | 已生成 |',
      ].join('\n'),
      status: 'complete',
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} />)

    expect(html).toContain('data-markdown-renderer="conversation"')
    expect(html).toContain('<table')
    expect(html).not.toContain('data-agent-running-text="true"')
  })

  test('renders completed NarraCat command labels as composer command pills', () => {
    const part: AgentMessagePart = {
      id: 'text-command-pill',
      type: 'text',
      text: '可以运行 /narracat:write，也可以先回到 /narracat:setup。',
      status: 'complete',
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} threadId="novel:stars" />)

    expect(html).toContain('data-agent-command-pill="/narracat:write"')
    expect(html).toContain('data-agent-command-pill-action="write-next"')
    expect(html).toContain('data-agent-command-pill="/narracat:setup"')
    expect(html).toContain('data-agent-command-pill-action="setup"')
    expect(html).toContain('写下一章')
    expect(html).toContain('设定')
  })

  test('keeps running NarraCat command labels as plain assistant markdown', () => {
    const part: AgentMessagePart = {
      id: 'text-running-command',
      type: 'text',
      text: '正在准备 /narracat:write。',
      status: 'running',
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} threadId="novel:stars" />)

    expect(html).toContain('data-agent-running-markdown="true"')
    expect(html).toContain('/narracat:write')
    expect(html).not.toContain('data-agent-command-pill="/narracat:write"')
  })

  test('renders setup next-step command labels as completed command pills', () => {
    const part: AgentMessagePart = {
      id: 'text-setup-next',
      type: 'text',
      text: [
        '创作根基已建立。建议下一步：',
        '',
        '/narracat:world - 创建角色和世界观设定',
        '/narracat:plan - 规划故事大纲（建议先创建主要角色）',
        '',
        '如尚未运行参考作品分析且有参考作品可用：',
        '/narracat:reference - 生成项目级参考指导（可选增强）',
      ].join('\n'),
      status: 'complete',
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} threadId="novel:stars" />)

    expect(html).toContain('data-agent-command-pill="/narracat:world"')
    expect(html).toContain('data-agent-command-pill-action="world"')
    expect(html).toContain('data-agent-command-pill="/narracat:plan"')
    expect(html).toContain('data-agent-command-pill-action="plan"')
    expect(html).toContain('data-agent-command-pill="/narracat:reference"')
    expect(html).toContain('data-agent-command-pill-action="reference"')
  })

  test('renders inline-code NarraCat command suggestions as completed command pills', () => {
    const part: AgentMessagePart = {
      id: 'text-inline-code-command-pill',
      type: 'text',
      text: [
        '下一步可做',
        '',
        '- `/narracat:world 创建主角` — 用同样的深度引导设计主角',
        '- `/narracat:world 创建仙盟盟主` — 设计前世道侣角色',
        '- `/narracat:plan` — 基于世界观规划大纲',
      ].join('\n'),
      status: 'complete',
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} threadId="novel:stars" />)

    expect(html).toContain('data-agent-command-pill="/narracat:world"')
    expect(html).toContain('data-agent-command-pill-action="world"')
    expect(html).toContain('data-agent-command-pill="/narracat:plan"')
    expect(html).toContain('data-agent-command-pill-action="plan"')
    expect(html).toContain('创建主角')
    expect(html).toContain('创建仙盟盟主')
  })

  test('keeps long markdown table cells and inline code inside the message width', () => {
    const longPath = '/Users/writer/Documents/NarraCat/codex-smoke-with-a-very-long-name/bible/zod-error-permission-result-with-an-extremely-long-field-name.md'
    const part: AgentMessagePart = {
      id: 'text-3',
      type: 'text',
      text: [
        `失败路径：\`${longPath}\``,
        '',
        '| 字段 | 值 |',
        '|---|---|',
        `| toolUseID | \`${longPath}\` |`,
      ].join('\n'),
      status: 'complete',
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} />)

    expect(html).toContain('min-w-0 w-full max-w-full overflow-x-auto')
    expect(html).toContain('w-max min-w-full')
    expect(html).toContain('whitespace-pre-wrap break-words align-top')
    expect(html).toContain('rounded-sm bg-active px-1 py-0.5 font-mono text-foreground break-words [overflow-wrap:anywhere]')
  })

  test('collapses running reasoning by default', () => {
    const part: AgentMessagePart = {
      id: 'reasoning-1',
      type: 'reasoning',
      text: '这里是完整思考过程',
      status: 'running',
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} />)

    expect(html).toContain('思考中...')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('这里是完整思考过程')
    expect(html).not.toContain('rounded-card border')
  })

  test('collapses completed reasoning by default', () => {
    const part: AgentMessagePart = {
      id: 'reasoning-2',
      type: 'reasoning',
      text: '已经完成的思考过程',
      status: 'complete',
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} />)

    expect(html).toContain('已完成思考')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('已经完成的思考过程')
    expect(html).not.toContain('rounded-card border')
  })

  test('collapses data blocks by default', () => {
    const part: AgentMessagePart = {
      id: 'data-1',
      type: 'data',
      name: 'context',
      title: '上下文包',
      status: 'complete',
      data: { chapter: 15 },
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} />)

    expect(html).toContain('上下文包')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('chapter')
    expect(html).not.toContain('rounded-card border')
  })

  test('renders model service required as a branded Settings guide', () => {
    const part: AgentMessagePart = {
      id: 'model-service-required',
      type: 'model-service-required',
      provider: 'deepseek',
      title: '先接通模型服务',
      detail: '完成“测试连接”后，Agent 才会开始执行创作任务。',
      status: 'failed',
    }

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AgentPartView part={part} />
      </MemoryRouter>,
    )

    expect(html).toContain('data-agent-model-service-guide="true"')
    expect(html).toContain('data-brand-illustration="model-service-needed"')
    expect(html).toContain('先接通模型服务')
    expect(html).toContain('打开模型服务')
    expect(html).toContain('href="/settings?section=model"')
    expect(html).not.toContain('rounded-card border border-destructive')
  })

  test('renders an interrupted run as a quiet neutral terminal notice', () => {
    const part: AgentMessagePart = {
      id: 'interrupted-1',
      type: 'error',
      tone: 'interrupted',
      title: '任务已中断',
      detail: '上次 Agent 运行因 App 退出或异常中断，未能正常收尾。',
      status: 'failed',
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} />)

    expect(html).toContain('data-agent-terminal-notice="interrupted"')
    expect(html).toContain('任务已中断')
    expect(html).toContain('已完成的内容仍然保留')
    expect(html).not.toContain('异常中断')
    expect(html).toContain('bg-warning/10')
    expect(html).toContain('text-foreground')
    expect(html).toContain('text-muted-foreground')
    expect(html).not.toContain('border-destructive')
    expect(html).not.toContain('text-destructive')
  })

  test('keeps a real run failure explicit without a full destructive frame', () => {
    const part: AgentMessagePart = {
      id: 'failed-1',
      type: 'error',
      title: '运行失败',
      detail: '模型服务暂时无法响应。',
      status: 'failed',
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} />)

    expect(html).toContain('data-agent-terminal-notice="failed"')
    expect(html).toContain('bg-destructive/10')
    expect(html).toContain('text-foreground')
    expect(html).toContain('text-muted-foreground')
    // 钉的是通知自己的外框没有红边；卡片里「报告问题」按钮基类带 aria-invalid:border-destructive 变体，
    // 那是冒号前缀的条件类，不算外框——用词边界排除掉它。
    expect(html).not.toMatch(/(^|[\s"])border-destructive/)
  })

  test('renders AskUserQuestion choices as selectable options', () => {
    const part: AgentMessagePart = {
      id: 'question-1',
      type: 'question',
      questionRequestId: 'tool-question-1',
      toolCallId: 'tool-question-1',
      status: 'running',
      questions: [
        {
          header: '概念',
          question: '这个故事关于什么？',
          options: [
            { label: '小人物', description: '从个体命运切入' },
            { label: '群像', description: '从群体关系切入' },
          ],
        },
      ],
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} />)

    expect(html).toContain('NarraCat 需要你选择')
    expect(html.indexOf('概念')).toBeLessThan(html.indexOf('NarraCat 需要你选择'))
    expect(html).toContain('这个故事关于什么？')
    expect(html).toContain('小人物')
    expect(html).toContain('从个体命运切入')
    expect(html).toContain('自定义回答')
    expect(html).toContain('不在选项里时，直接写你的设定')
    expect(html).toContain('提交选择')
    expect(html).toContain('data-agent-question-card="tool-question-1"')
    expect(html).toContain('data-agent-question-status="true"')
    expect(html).toContain('data-brand-illustration="agent-question"')
    expect(html).toContain('rounded-workspace')
    expect(html).toContain('pt-8')
    expect(html).toContain('flex-col items-start gap-1')
    expect(html).not.toContain('lucide-circle-help')
    expect(html).not.toContain('rounded-card')
    // 选项与自定义输入达到可读正文/表单字号，不再降级为 text-xs
    expect(html).toContain(AGENT_QUESTION_OPTION_CLASS)
    expect(html).not.toContain('text-xs leading-4')
    expect(html).not.toContain('text-xs leading-5')
  })

  test('toolName=Task 的 tool-call part 走子 agent 分组行，不落回普通工具行', () => {
    const part: AgentMessagePart = {
      id: 'task-1',
      type: 'tool-call',
      toolCallId: 'task-1',
      toolName: 'Task',
      title: '派发子 agent',
      status: 'running',
      input: { subagent_type: 'narracat:chapter-writer' },
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} />)

    expect(html).toContain('章节写手Agent')
    expect(html).toContain('正在准备')
  })

  test('toolName=Agent（SDK runtime）也走子 agent 分组行', () => {
    const part: AgentMessagePart = {
      id: 'task-2',
      type: 'tool-call',
      toolCallId: 'task-2',
      toolName: 'Agent',
      title: '派发子 agent',
      status: 'running',
      input: { subagent_type: 'chapter-writer' },
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} />)

    expect(html).toContain('章节写手Agent')
  })

  test('普通 Write part 仍走 AgentToolCallRow，不受分组行改动影响', () => {
    const part: AgentMessagePart = {
      id: 'write-1',
      type: 'tool-call',
      toolCallId: 'write-1',
      toolName: 'Write',
      title: '写入章节草稿',
      status: 'running',
      input: { file_path: 'manuscript/ch042.md' },
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} />)

    expect(html).toContain('正在写入 ch042.md')
    expect(html).not.toContain('Agent · ')
  })

  test('keeps completed AskUserQuestion status stacked above the submitted label', () => {
    const part: AgentMessagePart = {
      id: 'question-2',
      type: 'question',
      questionRequestId: 'tool-question-2',
      toolCallId: 'tool-question-2',
      status: 'complete',
      answers: {
        '下一步优先推进什么？': '主线',
      },
      questions: [
        {
          header: '走向',
          question: '下一步优先推进什么？',
          options: [
            { label: '主线', description: '先推进主线冲突' },
          ],
        },
      ],
    }

    const html = renderToStaticMarkup(<AgentPartView part={part} />)

    expect(html).toContain('data-agent-question-status="true"')
    expect(html).toContain('走向')
    expect(html).toContain('已提交选择')
    expect(html.indexOf('走向')).toBeLessThan(html.indexOf('已提交选择'))
    expect(html).toContain('flex-col items-start gap-1')
  })
})
