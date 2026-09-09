import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentComposer, AgentSlashCommandMenu } from './AgentComposer'
import { useAgentStore } from '@/lib/agent-store'
import { useNovelStore } from '@/lib/novel-store'

beforeEach(() => {
  useAgentStore.getState().resetAgentState()
  useNovelStore.getState().resetNovelState()
})

// AgentComposer 底栏挂了 AgentModelSwitcher（切片②T3），其 useNavigate 需要 Router 上下文，
// SSR 快照必须套 MemoryRouter，否则非运行态用例会抛「useNavigate() may be used only in the
// context of a <Router> component」。
function renderComposer(element: ReactNode): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <MemoryRouter>{element}</MemoryRouter>
    </TooltipProvider>,
  )
}

describe('AgentComposer', () => {
  test('renders quick actions as icon-backed writing controls', () => {
    const html = renderComposer(<AgentComposer elevated />)

    expect(html).toContain('写作指令')
    expect(html).toContain('data-agent-command="reference"')
    expect(html).toContain('data-agent-command="world"')
    expect(html).toContain('data-agent-command="plan"')
    expect(html).toContain('data-agent-command="write-next"')
    expect(html).toContain('data-agent-command="review"')
    expect(html).not.toContain('data-agent-command="setup"')
    expect(html).not.toContain('data-agent-command="rewrite"')
    expect(html).toContain('data-agent-command-menu-trigger="true"')
    expect(html).toContain('data-icon-tooltip="选择 Agent 指令"')
    expect(html).toContain('aria-label="选择 Agent 指令"')
    expect(html).toContain('aria-label="发送任务"')
    expect(html).toContain('<svg')
  })

  test('can hide global quick actions when the workbench supplies local content actions', () => {
    const html = renderComposer(<AgentComposer showQuickActions={false} />)

    expect(html).toContain('向 Agent 描述任务')
    expect(html).toContain('data-agent-command-menu-trigger="true"')
    expect(html).toContain('data-icon-tooltip="选择 Agent 指令"')
    expect(html).toContain('aria-label="选择 Agent 指令"')
    expect(html).not.toContain('写作指令')
    expect(html).not.toContain('写下一章')
    expect(html).not.toContain('调风格')
  })

  test('accepts workbench handoff drafts without losing existing user input silently', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentComposer.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('composerHandoffRequest')
    expect(source).toContain('data-agent-composer-handoff-confirm="true"')
    expect(source).toContain('替换当前输入')
    expect(source).toContain('保留当前输入')
    expect(source).toContain('target: currentHandoff?.target')
  })

  test('「调整内容」handoff 用空输入框+占位引导取代旧的「要求：」预填模板，边界约束发送时才包装进 prompt', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentComposer.tsx', import.meta.url)), 'utf-8')

    // 旧模板标记解析已删除，占位符改由 adjust spec 驱动引导文案
    expect(source).not.toContain('hasAgentComposerHandoffRequirement')
    expect(source).not.toContain('createAgentComposerHandoffDraft')
    expect(source).toContain('getAgentComposerAdjustPlaceholder(currentHandoff.adjust)')
    // 阻断发送的条件收紧为「adjust handoff 且草稿为空」，而非任意 handoff
    expect(source).toContain('const blocksHandoffRequirement = Boolean(currentHandoff?.adjust && normalizedDraft.length === 0)')
    expect(source).toContain(
      'const blocksHandoffRun = Boolean(\n      currentHandoff?.adjust && runAction === currentHandoff.command && normalizedDraft.length === 0,\n    )',
    )
    // 发送时才把用户要求包进带边界约束的完整 prompt，气泡展示干净的用户输入
    expect(source).toContain('createAgentComposerAdjustPrompt(currentHandoff.adjust, draft)')
    expect(source).toContain('displayPrompt: isAdjustRun ? normalizedDraft : undefined')
  })

  test('keeps command chips in the bottom action bar below the text editor', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentComposer.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('data-agent-composer-action-bar="true"')
    expect(source).toContain('data-agent-composer-command-slot="true"')
    expect(source).toContain('data-agent-composer-text-area="true"')
    expect(source.indexOf('data-agent-composer-text-area="true"')).toBeLessThan(
      source.indexOf('data-agent-composer-action-bar="true"'),
    )
    expect(source.indexOf('data-agent-composer-action-bar="true"')).toBeLessThan(
      source.indexOf('data-agent-composer-command-slot="true"'),
    )
    expect(source).not.toContain('absolute bottom-2 left-2')
    expect(source).not.toContain('absolute bottom-2 right-2')
    expect(source).not.toContain('flex-wrap content-start items-baseline')
  })

  test('uses command-specific placeholders without silently targeting the active chapter', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentComposer.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('getAgentQuickActionPlaceholder(selectedAction)')
    expect(source).toContain('data-placeholder={composerPlaceholder}')
    expect(source).toContain('selectedChapter: currentHandoff?.selectedChapter')
    expect(source).toContain('target: currentHandoff?.target')
    expect(source).toContain('preserveDraft')
    expect(source).toContain('resolveDraftAfterCommandSelection')
    expect(source).not.toContain('const activeChapter')
  })

  test('keeps the command menu in a floating popover outside composer flow', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentComposer.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('<AgentCommandMenuPopover expanded={expanded}>')
    expect(source).toContain('data-agent-command-menu-popover="true"')
    expect(source).toContain('bottom-[calc(100%+0.5rem)]')
    expect(source).toContain('z-50')
    expect(source).toContain('max-h-64 overflow-y-auto')
    expect(source).not.toContain('className="mb-2 overflow-hidden rounded-panel')
  })

  test('展开时指令面板锚定动作栏上方，避免溢出面板顶部', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentComposer.tsx', import.meta.url)), 'utf-8')

    // 展开态用贴近动作栏的锚点，折叠态保持浮在整块上方
    expect(source).toContain("expanded ? 'bottom-12' : 'bottom-[calc(100%+0.5rem)]'")
    expect(source).toContain('<AgentCommandMenuPopover expanded={expanded}>')
  })

  test('点击指令面板与触发器之外可关闭菜单', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentComposer.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain("document.addEventListener('pointerdown', handleOutsidePointerDown)")
    expect(source).toContain("target.closest('[data-agent-command-menu-popover]')")
    expect(source).toContain("target.closest('[data-agent-command-menu-trigger]')")
    expect(source).toContain('if (commandMenuOpen) closeCommandMenu({ suppressTooltip: true })')
    // / 菜单仅在点出输入框外时清空草稿
    expect(source).toContain('slashCommandMenuOpen && !composerRootRef.current?.contains(target)')
  })

  test('renders removable composer reference context outside the editable draft', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentComposer.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('data-agent-composer-reference-context="true"')
    expect(source).toContain('data-agent-composer-reference-remove="true"')
    expect(source).toContain('1 个已选文本片段')
    expect(source).toContain('line-clamp-5')
    expect(source).toContain('group-hover:pointer-events-auto')
    expect(source).toContain('createAgentComposerReferencePrompt')
    expect(source).toContain('function isSameComposerHandoff')
    expect(source).toContain('currentHandoff?.referenceContext?.text === nextHandoff.referenceContext?.text')
    expect(source.indexOf('<AgentComposerReferencePill')).toBeLessThan(
      source.indexOf('data-agent-composer-text-area="true"'),
    )
  })

  test('does not reopen the side-effect confirmation after removing a command chip', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentComposer.tsx', import.meta.url)), 'utf-8')
    const clearSelectedActionBody = source.match(/function clearSelectedAction\(\) \{(?<body>[\s\S]*?)\n  \}/)?.groups?.body ?? ''

    expect(clearSelectedActionBody).toContain('setDismissedSuggestionDraft(normalizedDraft)')
  })

  test('renders slash command choices with Chinese labels before the responsible Agent signature', () => {
    const html = renderToStaticMarkup(<AgentSlashCommandMenu actions={['setup', 'review']} onSelect={() => {}} />)

    expect(html).toContain('data-agent-slash-command-menu="true"')
    expect(html).toContain('data-agent-slash-command="setup"')
    expect(html).toContain('data-agent-slash-command-label="true"')
    expect(html).toContain('data-agent-slash-command-hint="true"')
    expect(html).toContain('data-agent-slash-command-content="true"')
    expect(html).toContain('ml-auto')
    // ADR-0016 + #401：⌘ 触发（默认）不向作者裸露 /narracat: 命令原型
    expect(html).not.toContain('/narracat:')
    expect(html.indexOf('设定')).toBeLessThan(html.indexOf('NarraCat'))
    expect(html.indexOf('审修章节')).toBeLessThan(html.indexOf('连续性审修Agent'))
    // 右侧署名=负责的 Agent 人读名，不再是 mono 等宽命令原型
    expect(html).not.toContain('font-mono')
  })

  test('仅当用户输入 / 触发菜单时才展示斜杠命令原型（#401）', () => {
    const html = renderToStaticMarkup(
      <AgentSlashCommandMenu actions={['setup', 'review']} slashTriggered onSelect={() => {}} />,
    )

    // 用户已在用斜杠语法，右侧 hint 换成 mono 命令原型帮助补全
    expect(html).toContain('/narracat:setup')
    expect(html).toContain('/narracat:review')
    expect(html).toContain('font-mono')
    expect(html).toContain('data-agent-slash-command-hint="true"')

    // 组件里由 slashCommandMenuOpen（草稿以 / 开头）驱动，⌘ 菜单不传即默认隐藏
    const source = readFileSync(fileURLToPath(new URL('./AgentComposer.tsx', import.meta.url)), 'utf-8')
    expect(source).toContain('slashTriggered={slashCommandMenuOpen}')
  })

  test('renders the menu item description under the title (用途说明)', () => {
    const html = renderToStaticMarkup(<AgentSlashCommandMenu actions={['world', 'plan']} onSelect={() => {}} />)

    expect(html).toContain('data-agent-slash-command-description="true"')
    expect(html).toContain('世界观与角色')
    expect(html).toContain('创建或调整世界观、角色、场景等设定')
    expect(html).toContain('生成大纲')
    expect(html).toContain('规划全书结构，生成卷与章节大纲')
    expect(html).toContain('大纲架构师Agent')
    expect(html).toContain('世界观策划Agent')
  })

  test('marks the active slash command option for keyboard navigation', () => {
    const html = renderToStaticMarkup(
      <AgentSlashCommandMenu actions={['setup', 'review']} activeIndex={1} onSelect={() => {}} />,
    )

    expect(html).toContain('data-agent-slash-command-active="true"')
    expect(html).toContain('aria-selected="true"')
    expect(html.indexOf('data-agent-slash-command="review"')).toBeLessThan(
      html.indexOf('data-agent-slash-command-active="true"'),
    )
  })

  test('moves slash command focus with arrow keys and chooses the focused option with Enter', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentComposer.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain("event.key === 'ArrowDown' || event.key === 'ArrowUp'")
    expect(source).toContain('setSlashCommandFocusIndex')
    expect(source).toContain('slashCommandActions[slashCommandFocusIndex]')
  })

  test('默认渲染收起态的展开按钮与文本区标记', () => {
    const html = renderComposer(<AgentComposer elevated />)

    expect(html).toContain('data-agent-composer-expand-toggle="true"')
    expect(html).toContain('aria-label="展开输入框"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('data-agent-composer-text-area="true"')
    expect(html).toContain('data-expanded="false"')
  })

  test('展开动画用 ≤300ms 的 framer-motion spring 且尊重 reduced-motion', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentComposer.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain("from 'framer-motion'")
    expect(source).toContain('useReducedMotion')
    expect(source).toContain("type: 'spring'")
    expect(source).toContain('duration: 0.28')
    expect(source).toContain('bounce: 0.2')
    expect(source).toContain('reduceMotion ? { duration: 0 }')
  })

  test('展开按钮限非运行态，发送后与运行时自动收起', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentComposer.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('data-agent-composer-expand-toggle="true"')
    expect(source).toContain('setExpanded((value) => !value)')
    expect(source).toContain('setExpanded(false)')
    expect(source).toContain('if (isRunning) setExpanded(false)')
  })

  test('把展开态通知父级（供浮层布局，避免挤压历史区）', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentComposer.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('onExpandedChange?: (expanded: boolean) => void')
    expect(source).toContain('onExpandedChange?.(expanded)')
  })

  test('发送「写下一章」前点击时拉取记忆待同步 map，取消则不发送且不清空草稿', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentComposer.tsx', import.meta.url)), 'utf-8')

    // 与 IPC 读取 wrapper 及纯函数产文案对齐（复用 WorkbenchStage 同一套拦截逻辑）
    expect(source).toContain(
      "import { cancelAgentRun, getPendingMemorySync, listManuscriptDrafts, startAgentRun } from '@/lib/ipc'",
    )
    expect(source).toContain(
      "import { buildPendingSyncWriteConfirm, buildPendingSyncWriteWarning } from '@/lib/pending-memory-sync-gate'",
    )

    const handleSubmitBody = source.match(/async function handleSubmit\([\s\S]*?\n  \}\n/)?.[0] ?? ''
    // 点击时才拉取（不挂 hook），且拦截逻辑发生在 startAgentRun 之前
    expect(handleSubmitBody).toContain(
      "if (runAction === 'write-next' && activeProject?.path) {\n        const pendingSyncWarning = await resolveWriteNextPendingSyncWarning(activeProject.path)\n        if (pendingSyncWarning && !(await confirm(buildPendingSyncWriteConfirm(pendingSyncWarning)))) {\n          return\n        }\n      }",
    )
    expect(handleSubmitBody.indexOf('resolveWriteNextPendingSyncWarning')).toBeLessThan(
      handleSubmitBody.indexOf('await startAgentRun('),
    )
    // 取消路径 return 早于 setEditorDraft('')，保留输入框内容；catch 内 fail-open
    expect(handleSubmitBody.indexOf("if (pendingSyncWarning")).toBeLessThan(
      handleSubmitBody.indexOf("setEditorDraft('')"),
    )

    const gateHelperBody =
      source.match(/async function resolveWriteNextPendingSyncWarning\([\s\S]*?\n\}\n/)?.[0] ?? ''
    expect(gateHelperBody).toContain('await getPendingMemorySync(projectPath)')
    expect(gateHelperBody).toContain("buildPendingSyncWriteWarning('write-next', map)")
    expect(gateHelperBody).toContain('catch (error)')
    expect(gateHelperBody).toContain('return null')
  })

  test('非运行态渲染快捷模型切换器触发器（切片②T3）', () => {
    const idleHtml = renderComposer(<AgentComposer elevated />)
    expect(idleHtml).toContain('data-agent-model-switcher-trigger="true"')
  })

  // zustand v5 的 useSyncExternalStore 在 renderToStaticMarkup（无 DOM 的纯 SSR 路径）下走
  // getServerSnapshot → api.getInitialState()，setState 之后的活动 run 永远读不到（该文件其余
  // 依赖 useAgentStore 的用例也同受此限，非本次改动引入），运行态隐藏改走源码断言核对同一条
  // 门控（与左侧指令 chip「运行中隐藏、不占位」同规则）。
  test('运行态隐藏快捷模型切换器且不占位（切片②T3）', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentComposer.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain("import { AgentModelSwitcher } from './AgentModelSwitcher'")
    expect(source).toContain('{!isRunning ? <AgentModelSwitcher /> : null}')
    // 门控紧跟弹簧占位之后、展开按钮之前，符合 brief 指定的插入位置
    expect(source.indexOf("<div className=\"min-w-0 flex-1\" />")).toBeLessThan(
      source.indexOf('{!isRunning ? <AgentModelSwitcher /> : null}'),
    )
    expect(source.indexOf('{!isRunning ? <AgentModelSwitcher /> : null}')).toBeLessThan(
      source.indexOf('data-agent-composer-expand-toggle="true"'),
    )
  })

  test('任务发出成功后清空指令 chip（dogfood #4：run 结束不应重新冒出旧 chip）', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentComposer.tsx', import.meta.url)), 'utf-8')
    const handleSubmitBody = source.match(/async function handleSubmit\([\s\S]*?\n  \}\n/)?.[0] ?? ''

    // 成功块（startAgentRun 之后、catch 之前）必须清 selectedAction，否则 run 期间被 !isRunning 隐藏的
    // chip 会在 run 结束后因状态未清而重新出现
    const successBlock =
      handleSubmitBody.match(/await startAgentRun\([\s\S]*?\)\n([\s\S]*?)\n    \} catch \(error\) \{/)?.[1] ?? ''
    expect(successBlock).toContain("setSelectedAction(null)")
    expect(successBlock).toContain("setEditorDraft('')")
    expect(successBlock).toContain('setCurrentHandoff(null)')

    // 早退分支（待同步取消 / blocksRunAction 等）不得被这次改动波及，必须仍保留 chip 与草稿
    expect(handleSubmitBody.indexOf('if (blocksRunAction || blocksHandoffRun || !hasRunnableInput)')).toBeLessThan(
      handleSubmitBody.indexOf('setSelectedAction(null)'),
    )
  })
})
