import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkbenchStage } from './WorkbenchStage'
import { useAgentStore } from '@/lib/agent-store'
import { useNovelStore } from '@/lib/novel-store'
import type { NovelProjectDetail } from '@shared/types/novel'

const project: NovelProjectDetail = {
  id: 'novel-1',
  title: '星辰大海',
  path: '/novels/stars',
  status: 'ready',
  chapterProgress: '1 / 2 章',
  wordCountLabel: '2100 字',
  tocItems: [],
  treeItems: [
    { id: 'master-outline', kind: 'master-outline', title: '全书大纲', level: 0, exists: true },
    { id: 'foundation', kind: 'foundation', title: '创作根基', level: 0, exists: false },
  ],
}

beforeEach(() => {
  useNovelStore.getState().resetNovelState()
  useAgentStore.getState().resetAgentState()
})

function agentPanelColumnClass(html: string): string {
  return html.match(/<div class="([^"]+)" data-agent-panel-column="true"/)?.[1] ?? ''
}

function contentCardClass(html: string): string {
  return html.match(/<div class="([^"]+)" data-workbench-content-card="true"/)?.[1] ?? ''
}

describe('WorkbenchStage', () => {
  test('renders the content and Agent areas as separate cards with an 8px resize lane', () => {
    useNovelStore.getState().setActiveProject(project)

    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MemoryRouter>
          <WorkbenchStage selectedSectionId="settings" selectedObjectId={null} selectedTabId="foundation" />
        </MemoryRouter>
      </TooltipProvider>,
    )

    expect(html).toContain('data-workbench-stage="true"')
    // 顶部 padding 消费 --titlebar-gutter-top（win32 上下分区：卡片从 caption 带下开始）
    expect(html).toContain('pt-[max(0.75rem,var(--titlebar-gutter-top))] pb-3 pl-0 pr-3')
    expect(html).not.toContain('flex-1 py-3 pl-0 pr-3')
    expect(html).not.toContain('flex-1 p-3 pt-0')
    expect(html).toContain('data-workbench-stage-grid="true"')
    expect(html).toContain('minmax(0, 1fr) 8px 460px')
    expect(html).toContain('data-workbench-content-card="true"')
    expect(html).toContain('data-workbench-agent-resize-handle="true"')
    expect(html).toContain('aria-label="调整 Agent 面板宽度"')
    expect(html).toContain('data-agent-panel-column="true"')
    expect(contentCardClass(html)).toContain('rounded-workspace border border-border bg-workspace')
    expect(agentPanelColumnClass(html)).toContain('rounded-workspace border border-border bg-workspace')
    expect(contentCardClass(html)).not.toContain('shadow-[var(--shadow-workspace)]')
    expect(agentPanelColumnClass(html)).not.toContain('shadow-[var(--shadow-workspace)]')
    expect(agentPanelColumnClass(html)).not.toContain('border-l border-border')
    expect(agentPanelColumnClass(html)).not.toContain('p-3')
    expect(agentPanelColumnClass(html)).not.toContain('pl-0')
  })

  test('allows the agent panel column to shrink around long conversation content', () => {
    useNovelStore.getState().setActiveProject(project)

    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MemoryRouter>
          <WorkbenchStage selectedSectionId="settings" selectedObjectId={null} selectedTabId="foundation" />
        </MemoryRouter>
      </TooltipProvider>,
    )

    expect(agentPanelColumnClass(html)).toContain('min-w-0')
    expect(agentPanelColumnClass(html)).toContain('overflow-hidden')
  })

  test('唠个嗑板块占满中间舞台，不保留右侧 Agent 对话框', () => {
    useNovelStore.getState().setActiveProject(project)

    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MemoryRouter>
          <WorkbenchStage selectedSectionId="chat" selectedObjectId={null} selectedTabId={null} />
        </MemoryRouter>
      </TooltipProvider>,
    )

    expect(html).toContain('data-character-chat-board="true"')
    expect(html).not.toContain('data-workbench-agent-resize-handle="true"')
    expect(html).not.toContain('data-workbench-agent-panel="true"')
    expect(html).not.toContain('data-agent-panel-column="true"')
    expect(html).not.toContain('minmax(0, 1fr) 8px 460px')
  })

  test('does not render a persistent bottom action dock for workbench content pages', () => {
    useNovelStore.getState().setActiveProject(project)

    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MemoryRouter>
          <WorkbenchStage selectedSectionId="blueprint" selectedObjectId={null} selectedTabId="master-outline" />
        </MemoryRouter>
      </TooltipProvider>,
    )

    expect(html).not.toContain('data-workbench-action-dock="true"')
  })

  test('allows sequential planning actions to run without selected chapter context', () => {
    const source = readFileSync(fileURLToPath(new URL('./WorkbenchStage.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('action.omitSelectedChapter ? undefined : selectedItem?.chapterNumber')
  })

  test('uses the shared pixel resize contract between content and the Agent conversation area', () => {
    const source = readFileSync(fileURLToPath(new URL('./WorkbenchStage.tsx', import.meta.url)), 'utf-8')

    expect(source).not.toContain('react-resizable-panels')
    expect(source).toContain('workbenchStageGridTemplateColumns(agentWidth)')
    expect(source).toContain('gridTemplateRows: WORKBENCH_GRID_TEMPLATE_ROWS')
    expect(source).toContain('data-workbench-stage-content-panel="true"')
    expect(source).toContain('data-workbench-agent-panel="true"')
    expect(source).toContain('data-workbench-agent-resize-handle="true"')
    expect(source).toContain('WORKBENCH_RESIZE_HANDLE_CLASS')
  })

  test('navigates to targeted generated content before starting the Agent run', () => {
    const source = readFileSync(fileURLToPath(new URL('./WorkbenchStage.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('const navigate = useNavigate()')
    expect(source).toContain('buildWorkbenchTargetHref')
    expect(source).toContain('navigate(buildWorkbenchTargetHref')
    expect(source.indexOf('navigate(buildWorkbenchTargetHref')).toBeLessThan(source.indexOf('await startAgentRun'))
  })

  test('routes composer handoff actions without starting an Agent run', () => {
    const source = readFileSync(fileURLToPath(new URL('./WorkbenchStage.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain("action.kind === 'composer-handoff'")
    expect(source).toContain('requestComposerHandoff')
    expect(source.indexOf("action.kind === 'composer-handoff'")).toBeLessThan(source.indexOf("action.kind === 'agent'"))
  })

  test('routes text selection handoff through the composer while Agent work is idle', () => {
    const source = readFileSync(fileURLToPath(new URL('./WorkbenchStage.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain(
      [
        'function handleSelectionHandoff(handoff: Omit<AgentComposerHandoff, \'id\'>) {',
        '    if (activeRun || submitting) {',
        '      toast.info(\'Agent 正在执行任务，请等待完成后再试\')',
        '      return',
        '    }',
      ].join('\n'),
    )
    expect(source).toContain('requestComposerHandoff(handoff, agentThreadId)')
    expect(source).toContain('onSelectionHandoff={handleSelectionHandoff}')
    expect(source).toContain('selectionHandoffDisabled={isAgentBusy}')
  })

  test('uses the novel scoped Agent thread for panel state and run requests', () => {
    const source = readFileSync(fileURLToPath(new URL('./WorkbenchStage.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('getAgentThreadIdForProject(project)')
    expect(source).toContain('threadId: agentThreadId')
    expect(source).toContain('threadId={agentThreadId}')
    expect(source).toContain('WorkbenchContentView')
    expect(source).toContain('agentThreadId={agentThreadId}')
  })

  test('uses one controlled chapter tab state for titlebar actions and content rendering', () => {
    const source = readFileSync(fileURLToPath(new URL('./WorkbenchStage.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('resolveDefaultChapterView')
    expect(source).toContain('selectedChapterView ?? defaultChapterView')
    expect(source).toContain('onSelectedChapterViewChange?.(value)')
    expect(source).toContain('getWorkbenchActions({ project, selectedItem, artifacts, chapterView })')
    expect(source).toContain('chapterView={chapterView}')
    expect(source).toContain('onChapterViewChange={handleChapterViewChange}')
    expect(source).not.toContain('onChapterViewResolved')
  })
})
